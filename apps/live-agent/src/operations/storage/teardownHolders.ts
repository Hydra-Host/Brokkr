// Teardown must run top-down (deepest holder first); RAID arrays with any member on a preserved disk are skipped entirely — stopping them would destroy the preserved member's data path.

import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
const logger = makeLogger('storage');

export class HolderTeardownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HolderTeardownError';
  }
}

const LAYER_PRIORITY: Record<string, number> = {
  crypt: 0,
  lvm: 1,
  raid: 2,
  partition: 3,
  disk: 4,
};

const MAX_HOLDER_DEPTH = 20;
const NVME_RE = /^(nvme\d+n\d+)/;

type LayerType = 'crypt' | 'lvm' | 'raid' | 'partition' | 'disk';

export interface HolderNode {
  name: string;
  layer_type: LayerType;
  depth: number;
  holders: HolderNode[];
}

export interface TeardownSummary {
  crypt_closed: string[];
  lvm_removed: string[];
  vg_removed: string[];
  raid_stopped: string[];
  swap_deactivated: string[];
  signatures_cleared: string[];
  skipped_preserved: string[];
}

function newSummary(): TeardownSummary {
  return {
    crypt_closed: [],
    lvm_removed: [],
    vg_removed: [],
    raid_stopped: [],
    swap_deactivated: [],
    signatures_cleared: [],
    skipped_preserved: [],
  };
}

function sortKey(n: HolderNode): [number, number] {
  return [-n.depth, LAYER_PRIORITY[n.layer_type] ?? 99];
}

export function diskNameFromPartition(device: string): string {
  const name = device.replace(/^\/dev\//, '');
  const m = NVME_RE.exec(name);
  if (m) return m[1]!;
  return name.replace(/\d+$/, '');
}

function flattenTree(node: HolderNode): HolderNode[] {
  const nodes: HolderNode[] = [];
  for (const child of node.holders) {
    nodes.push(...flattenTree(child));
  }
  nodes.push(node);
  return nodes;
}

async function runIgnore(cmd: string, args: readonly string[], timeout_ms = 60_000): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout_ms, quiet_nonzero: true });
    return stdout;
  } catch {
    return '';
  }
}

async function isBlockDevice(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isBlockDevice();
  } catch {
    return false;
  }
}

async function getSysfsHolders(device: string): Promise<string[]> {
  try {
    const entries = await readdir(`/sys/class/block/${device}/holders`);
    return entries.filter((e) => e.length > 0);
  } catch {
    return [];
  }
}

async function getSysfsPartitions(device: string): Promise<string[]> {
  try {
    const entries = await readdir(`/sys/class/block/${device}`);
    return entries.filter((e) => e.startsWith(device) && e !== device);
  } catch {
    return [];
  }
}

async function getDmUuid(device: string): Promise<string> {
  const stdout = await runIgnore('dmsetup', ['info', `/dev/${device}`, '-C', '-o', 'uuid', '--noheadings']);
  return stdout.trim();
}

async function identifyLayerType(device: string): Promise<LayerType> {
  try {
    await access(`/sys/class/block/${device}/partition`);
    return 'partition';
  } catch (error) {
    logger.trace('sysfs partition probe missed', { device, error: getErrorMessage(error) });
  }

  if (device.startsWith('md')) return 'raid';

  if (device.startsWith('dm-')) {
    const uuid = await getDmUuid(device);
    if (uuid.startsWith('CRYPT')) return 'crypt';
    if (uuid.startsWith('LVM')) return 'lvm';
    return 'lvm';
  }

  return 'disk';
}

async function discoverHolders(device: string, depth: number, jobLog: JobLog): Promise<HolderNode | null> {
  if (depth > MAX_HOLDER_DEPTH) {
    await jobLog.warn(
      `Holder tree depth ${depth} exceeds maximum (${MAX_HOLDER_DEPTH}) at ${device}, stopping recursion`,
    );
    return null;
  }

  const layer_type = await identifyLayerType(device);
  const node: HolderNode = { name: device, layer_type, depth, holders: [] };

  const holders = await getSysfsHolders(device);

  if (layer_type === 'disk' || layer_type === 'raid') {
    const partitions = await getSysfsPartitions(device);
    for (const p of partitions) {
      if (!holders.includes(p)) holders.push(p);
    }
  }

  for (const holder of holders) {
    const child = await discoverHolders(holder, depth + 1, jobLog);
    if (child) node.holders.push(child);
  }

  return node;
}

async function closeCrypt(device: string, summary: TeardownSummary, jobLog: JobLog): Promise<void> {
  let mapperName: string | undefined;
  try {
    mapperName = device;
    try {
      mapperName = (await readFile(`/sys/class/block/${device}/dm/name`, 'utf8')).trim();
    } catch (error) {
      await jobLog.warn(`Could not read dm name for crypt device ${device}: ${getErrorMessage(error)}`);
    }

    if (!mapperName) mapperName = device;

    await jobLog.info(`Closing dm-crypt device: /dev/mapper/${mapperName}`);

    const closeResult = await run('cryptsetup', ['close', `/dev/mapper/${mapperName}`], {
      timeout_ms: 60_000,
    }).catch(() => ({ exit_code: 1 }));
    if (closeResult.exit_code !== 0) {
      await runIgnore('cryptsetup', ['remove', `/dev/mapper/${mapperName}`]);
    }
    summary.crypt_closed.push(mapperName);
  } catch (error) {
    await jobLog.warn(`Non-fatal: failed to close crypt device ${device}: ${getErrorMessage(error)}`);
  } finally {
    // cryptsetup can exit 0 yet leave the dm node mapped (corrupt LUKS header / kernel desync), which blocks curtin — always attempt dmsetup removal.
    if (mapperName) {
      await runIgnore('dmsetup', ['remove', '--force', `/dev/mapper/${mapperName}`], 10_000);
    }
  }
}

export function findPreservedVgPvs(pvNames: readonly string[], preserveDisks: ReadonlySet<string>): string[] {
  return pvNames.filter((pv) => preserveDisks.has(diskNameFromPartition(pv)));
}

function isMdDevice(pv: string): boolean {
  return /^\/dev\/md\d+/.test(pv);
}

export function mdPartitionParent(pv: string): string {
  const m = /^(\/dev\/md\d+)p\d+$/.exec(pv);
  return m ? m[1]! : '';
}

function isDmDevice(pv: string): boolean {
  return pv.startsWith('/dev/mapper/') || /^\/dev\/dm-\d+/.test(pv);
}

// Resolve a dm PV to its non-dm backing devices via sysfs slaves — catches LVM-on-LUKS on a preserved disk, where diskNameFromPartition can never match.
async function resolveDmBackingDevices(pv: string, depth = 0): Promise<string[]> {
  if (depth > MAX_HOLDER_DEPTH) return [];
  let name = pv.replace(/^\/dev\//, '');
  if (name.startsWith('mapper/')) {
    name = (await runIgnore('dmsetup', ['info', pv, '-C', '-o', 'blkdevname', '--noheadings'])).trim() || name;
  }
  let slaves: string[];
  try {
    slaves = (await readdir(`/sys/class/block/${name}/slaves`)).filter((e) => e.length > 0);
  } catch {
    return [];
  }
  const leaves: string[] = [];
  for (const slave of slaves) {
    if (slave.startsWith('dm-')) {
      leaves.push(...(await resolveDmBackingDevices(`/dev/${slave}`, depth + 1)));
    } else {
      leaves.push(`/dev/${slave}`);
    }
  }
  return leaves;
}

async function vgNameOfDmNode(name: string): Promise<string> {
  let dmName = '';
  try {
    dmName = (await readFile(`/sys/class/block/${name.replace(/^\/dev\//, '')}/dm/name`, 'utf8')).trim();
  } catch {
    dmName = name.startsWith('/dev/mapper/') ? name.slice('/dev/mapper/'.length) : '';
  }
  if (!dmName) return '';
  const splitRaw = await runIgnore('dmsetup', [
    'splitname',
    dmName,
    '-c',
    '--noheadings',
    '-o',
    'vg_name',
    '--separator',
    '/',
  ]);
  return splitRaw.trim();
}

async function mdMembersTouchPreserved(array: string, preserveDisks: ReadonlySet<string>): Promise<boolean> {
  const probe = await probeMdadmMembers(array);
  if (!probe.ok) {
    return preserveDisks.size > 0;
  }
  return findPreservedRaidMembers(probe.members, preserveDisks).length > 0;
}

// md/dm PVs map to synthetic names that never match a physical preserved disk, so expand them to backing disks first; removeLvm runs before stopRaid, so this is the only preserve guard that fires for the LVM layer.
async function findPreservedVgPvsResolvingMd(
  pvNames: readonly string[],
  preserveDisks: ReadonlySet<string>,
): Promise<string[]> {
  const preserved = new Set(findPreservedVgPvs(pvNames, preserveDisks));
  for (const pv of pvNames) {
    if (preserved.has(pv)) continue;

    if (isMdDevice(pv) && !mdPartitionParent(pv)) {
      if (await mdMembersTouchPreserved(pv, preserveDisks)) preserved.add(pv);
      continue;
    }

    const parent = mdPartitionParent(pv);
    if (parent) {
      if (await mdMembersTouchPreserved(parent, preserveDisks)) preserved.add(pv);
      continue;
    }

    if (isDmDevice(pv)) {
      const backing = await resolveDmBackingDevices(pv);
      let hit = backing.some((b) => preserveDisks.has(diskNameFromPartition(b)));
      if (!hit) {
        for (const b of backing) {
          if (isMdDevice(b) && (await mdMembersTouchPreserved(b, preserveDisks))) {
            hit = true;
            break;
          }
        }
      }
      if (hit) preserved.add(pv);
    }
  }
  return [...preserved];
}

export async function removeLvm(
  device: string,
  preserveDisks: Set<string>,
  summary: TeardownSummary,
  jobLog: JobLog,
): Promise<void> {
  try {
    let dmName = '';
    try {
      dmName = (await readFile(`/sys/class/block/${device}/dm/name`, 'utf8')).trim();
    } catch (error) {
      await jobLog.warn(`Could not read dm name for LVM device ${device}: ${getErrorMessage(error)}`);
    }
    if (!dmName) return;

    const splitRaw = await runIgnore('dmsetup', [
      'splitname',
      dmName,
      '-c',
      '--noheadings',
      '-o',
      'vg_name,lv_name',
      '--separator',
      '/',
    ]);
    const split = splitRaw.trim();
    if (!split.includes('/')) {
      await jobLog.warn(`Could not parse LVM name from dm device ${device} (dm_name=${dmName})`);
      return;
    }

    const idx = split.indexOf('/');
    const vgName = split.slice(0, idx);
    const lvName = split.slice(idx + 1);
    const vgLv = `${vgName}/${lvName}`;

    const pvsRaw = await runIgnore('pvs', ['--noheadings', '-o', 'pv_name', '--select', `vg_name=${vgName}`]);
    const pvols = pvsRaw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Fail CLOSED: an active LV proves the VG has PVs, so empty enumeration means pvs failed — abort rather than skip the only LVM-layer preserve guard.
    if (preserveDisks.size > 0 && pvols.length === 0) {
      await jobLog.warn(
        `PRESERVE: aborting LVM teardown for VG ${vgName} (lv ${vgLv}) — PV enumeration returned nothing for an active LV; cannot prove the VG avoids preserved disks`,
      );
      return;
    }
    const preservedPvs = await findPreservedVgPvsResolvingMd(pvols, preserveDisks);
    if (preservedPvs.length > 0) {
      await jobLog.info(
        `PRESERVE: skipping LVM teardown for VG ${vgName} (lv ${vgLv}) — PVs ${JSON.stringify(preservedPvs)} belong to preserved disks`,
      );
      return;
    }

    await jobLog.info(`Removing LVM logical volume: ${vgLv}`);
    // dmsetup first: distro udev rules (69-lvm.rules pvscan --cache -aay) race lvremove and pin the LV in D-state; lvchange/lvremove after are metadata-only.
    await runIgnore('dmsetup', ['remove', '--force', dmName], 10_000);
    await runIgnore('lvchange', ['-an', vgLv], 5_000);
    await runIgnore('lvremove', ['--force', '--force', vgLv], 5_000);
    summary.lvm_removed.push(vgLv);

    const remaining = await runIgnore('lvs', ['--noheadings', '-o', 'lv_name', '--select', `vg_name=${vgName}`]);
    if (!remaining.trim()) {
      await jobLog.info(`Removing empty volume group: ${vgName}`);
      await runIgnore('vgchange', ['-an', vgName], 15_000);
      await runIgnore('vgremove', ['--force', '--force', vgName], 15_000);
      summary.vg_removed.push(vgName);

      for (const pv of pvols) {
        await runIgnore('pvremove', ['--force', '--force', '--yes', pv], 15_000);
      }
    }

    await runIgnore('pvscan', ['--cache']);
  } catch (error) {
    await jobLog.warn(`Non-fatal: failed to remove LVM device ${device}: ${getErrorMessage(error)}`);
  }
}

function parseMdadmMembers(detailOutput: string, devpath: string): string[] {
  const members: string[] = [];
  for (const line of detailOutput.split('\n')) {
    if (!line.includes('/dev/')) continue;
    if (line.includes(devpath)) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length === 0) continue;
    const last = tokens[tokens.length - 1]!;
    if (last.startsWith('/dev/')) members.push(last);
  }
  return members;
}

export function findPreservedRaidMembers(members: readonly string[], preserveDisks: ReadonlySet<string>): string[] {
  return members.filter((m) => preserveDisks.has(diskNameFromPartition(m)));
}

export type MdMemberProbe = { ok: true; members: string[] } | { ok: false };

export async function probeMdadmMembers(array: string): Promise<MdMemberProbe> {
  try {
    const result = await run('mdadm', ['--detail', array], { timeout_ms: 60_000, quiet_nonzero: true });
    if (result.exit_code !== 0) {
      return { ok: false };
    }
    const members = parseMdadmMembers(result.stdout, array);
    if (members.length === 0) {
      return { ok: false };
    }
    return { ok: true, members };
  } catch {
    return { ok: false };
  }
}

export function holderSortKey(n: { depth: number; layer_type: LayerType }): [number, number] {
  return [-n.depth, LAYER_PRIORITY[n.layer_type] ?? 99];
}

async function stopRaid(
  device: string,
  preserveDisks: Set<string>,
  summary: TeardownSummary,
  jobLog: JobLog,
): Promise<void> {
  try {
    const devpath = `/dev/${device}`;

    if (!(await isBlockDevice(devpath))) {
      await jobLog.debug(`RAID device ${devpath} does not exist, skipping`);
      return;
    }

    const probe = await probeMdadmMembers(devpath);
    if (!probe.ok && preserveDisks.size > 0) {
      await jobLog.info(
        `PRESERVE: skipping RAID array ${devpath} — mdadm --detail did not enumerate members; cannot prove it avoids preserved disks`,
      );
      return;
    }
    const members = probe.ok ? probe.members : [];

    const preservedMembers = findPreservedRaidMembers(members, preserveDisks);
    if (preservedMembers.length > 0) {
      await jobLog.info(
        `PRESERVE: skipping RAID array ${devpath} — members ${JSON.stringify(preservedMembers)} belong to preserved disks`,
      );
      return;
    }

    try {
      await writeFile(`/sys/block/${device}/md/sync_action`, 'idle');
    } catch (error) {
      await jobLog.warn(`Failed to set sync_action=idle on ${device}: ${getErrorMessage(error)}`);
    }
    try {
      await writeFile(`/sys/block/${device}/md/sync_action`, 'frozen');
    } catch (error) {
      await jobLog.warn(`Failed to set sync_action=frozen on ${device}: ${getErrorMessage(error)}`);
    }

    await jobLog.info(`Stopping RAID array: ${devpath} (members: ${JSON.stringify(members)})`);
    await runIgnore('mdadm', ['--stop', devpath]);
    summary.raid_stopped.push(device);

    for (const member of members) {
      await runIgnore('mdadm', ['--zero-superblock', member]);
    }
  } catch (error) {
    await jobLog.warn(`Non-fatal: failed to stop RAID device ${device}: ${getErrorMessage(error)}`);
  }
}

async function deactivateSwap(
  disks: string[],
  preserveDisks: Set<string>,
  summary: TeardownSummary,
  jobLog: JobLog,
): Promise<void> {
  try {
    let swapRaw = '';
    try {
      swapRaw = await readFile('/proc/swaps', 'utf8');
    } catch {
      return;
    }
    for (const line of swapRaw.split('\n')) {
      if (!line.startsWith('/dev/')) continue;
      const swapPath = line.split(/\s+/)[0]!;
      const swapBase = diskNameFromPartition(swapPath);
      if (disks.includes(swapBase) && !preserveDisks.has(swapBase)) {
        await jobLog.info(`Deactivating swap: ${swapPath}`);
        await runIgnore('swapoff', [swapPath]);
        summary.swap_deactivated.push(swapPath);
      }
    }
  } catch (error) {
    await jobLog.warn(`Non-fatal: failed to deactivate swap: ${getErrorMessage(error)}`);
  }
}

async function assembleRaidArrays(jobLog: JobLog): Promise<void> {
  try {
    await jobLog.debug('Scanning for existing RAID arrays');
    await runIgnore('mdadm', ['--assemble', '--scan']);
  } catch (error) {
    await jobLog.debug(`RAID assembly scan returned: ${getErrorMessage(error)}`);
  }
}

export async function clearSignaturesExcludingSharedStacks(
  toTeardown: readonly string[],
  sharedStackSiblings: ReadonlySet<string>,
  summary: TeardownSummary,
  jobLog: JobLog,
  clearer: (disk: string, summary: TeardownSummary, jobLog: JobLog) => Promise<void> = clearPartitionSignatures,
): Promise<void> {
  for (const disk of toTeardown) {
    if (sharedStackSiblings.has(disk)) {
      await jobLog.info(`PRESERVE: skipping signature clear on ${disk} — shares a surviving preserved RAID/VG stack`);
      continue;
    }
    await clearer(disk, summary, jobLog);
  }
}

async function clearPartitionSignatures(disk: string, summary: TeardownSummary, jobLog: JobLog): Promise<void> {
  try {
    const partitions = await getSysfsPartitions(disk);
    for (const part of partitions) {
      await jobLog.debug(`Clearing signatures on partition /dev/${part}`);
      await runIgnore('wipefs', ['--all', '--force', `/dev/${part}`], 30_000);
      summary.signatures_cleared.push(part);
    }
  } catch (error) {
    await jobLog.warn(`Non-fatal: failed to clear partition signatures on ${disk}: ${getErrorMessage(error)}`);
  }
}

async function teardownNode(
  node: HolderNode,
  preserveDisks: Set<string>,
  summary: TeardownSummary,
  jobLog: JobLog,
): Promise<void> {
  if (node.layer_type === 'crypt') {
    await closeCrypt(node.name, summary, jobLog);
  } else if (node.layer_type === 'lvm') {
    await removeLvm(node.name, preserveDisks, summary, jobLog);
  } else if (node.layer_type === 'raid') {
    await stopRaid(node.name, preserveDisks, summary, jobLog);
  }
}

interface JobLog {
  info(msg: string): Promise<void>;
  warn(msg: string): Promise<void>;
  debug(msg: string): Promise<void>;
}

function makeJobLog(): JobLog {
  return {
    async info(msg) {
      logger.info(msg, { component: 'teardownHolders' });
    },
    async warn(msg) {
      logger.warn(msg, { component: 'teardownHolders' });
    },
    async debug(msg) {
      logger.debug(msg, { component: 'teardownHolders' });
    },
  };
}

async function sweepAndValidate(
  toTeardown: string[],
  preserveDisks: Set<string>,
  summary: TeardownSummary,
  jobLog: JobLog,
): Promise<void> {
  const collectSurvivors = async (): Promise<string[]> => {
    const survivors: string[] = [];
    const seen = new Set<string>();
    for (const disk of toTeardown) {
      const tree = await discoverHolders(disk, 0, jobLog);
      if (!tree) continue;
      for (const node of flattenTree(tree)) {
        if (node.layer_type === 'disk' || node.layer_type === 'partition') continue;
        if (seen.has(node.name)) continue;
        seen.add(node.name);
        if (await isBlockDevice(`/dev/${node.name}`)) {
          survivors.push(node.name);
        }
      }
    }
    return survivors;
  };

  const survivors = await collectSurvivors();
  if (survivors.length === 0) return;

  await jobLog.warn(`Phase 6: ${survivors.length} residual holders survived teardown: ${JSON.stringify(survivors)}`);

  const preservedSurvivors = new Set<string>();
  for (const name of survivors) {
    if (name.startsWith('dm-')) {
      await runIgnore('dmsetup', ['remove', '--force', `/dev/${name}`], 10_000);
    } else if (name.startsWith('md')) {
      if (await mdMembersTouchPreserved(`/dev/${name}`, preserveDisks)) {
        preservedSurvivors.add(name);
        await jobLog.info(
          `PRESERVE: leaving residual RAID array /dev/${name} up — touches (or may touch) a preserved disk`,
        );
        continue;
      }
      await runIgnore('mdadm', ['--stop', `/dev/${name}`], 10_000);
    }
  }

  const remaining = (await collectSurvivors()).filter((name) => !preservedSurvivors.has(name));
  if (remaining.length > 0) {
    throw new HolderTeardownError(
      `Holder teardown could not clear residual holders on target disks ${JSON.stringify(toTeardown)}: ${JSON.stringify(remaining)}. Curtin will fail with 'device busy' if allowed to proceed. Operator intervention or device reboot required.`,
    );
  }
}

export async function teardownDisks(
  disks: string[],
  preserveDisks: Set<string>,
  jobLog: JobLog = makeJobLog(),
): Promise<TeardownSummary> {
  const summary = newSummary();

  const toTeardown: string[] = [];
  for (const d of disks) {
    if (preserveDisks.has(d)) {
      summary.skipped_preserved.push(d);
      await jobLog.info(`PRESERVE: skipping disk ${d} entirely`);
    } else {
      toTeardown.push(d);
    }
  }

  if (toTeardown.length === 0) {
    await jobLog.info('No disks to tear down (all preserved)');
    return summary;
  }

  await jobLog.info(`Starting holder teardown for ${toTeardown.length} disks: ${JSON.stringify(toTeardown)}`);

  // Drain pending udev events so DM_UDEV_WAIT_FLAG handshakes inside lvremove/dmsetup don't deadlock against stale events.
  await runIgnore('udevadm', ['settle', '--timeout=5'], 10_000);

  await assembleRaidArrays(jobLog);

  await deactivateSwap(toTeardown, preserveDisks, summary, jobLog);

  const allNodes: HolderNode[] = [];
  for (const disk of toTeardown) {
    const tree = await discoverHolders(disk, 0, jobLog);
    if (tree) allNodes.push(...flattenTree(tree));
  }

  const seen = new Set<string>();
  const uniqueNodes: HolderNode[] = [];
  for (const node of allNodes) {
    if (!seen.has(node.name)) {
      seen.add(node.name);
      uniqueNodes.push(node);
    }
  }

  uniqueNodes.sort((a, b) => {
    const [ad, ap] = sortKey(a);
    const [bd, bp] = sortKey(b);
    return ad - bd || ap - bp;
  });

  await jobLog.info(`Discovered ${uniqueNodes.length} holder layers to tear down`);
  for (const node of uniqueNodes) {
    await jobLog.debug(`  depth=${node.depth} type=${node.layer_type} name=${node.name}`);
  }

  for (const node of uniqueNodes) {
    if (node.layer_type === 'disk') continue;
    if (node.layer_type === 'partition' && preserveDisks.has(diskNameFromPartition(node.name))) {
      await jobLog.info(`PRESERVE: skipping partition ${node.name} (belongs to preserved disk)`);
      continue;
    }
    await teardownNode(node, preserveDisks, summary, jobLog);
  }

  // NEVER clear signatures on a wipe-target sharing a RAID/VG/crypt stack with a preserved disk — stopRaid leaves such arrays up and wipefs on a sibling member would corrupt the surviving preserved array; the wipeDisks guard only runs AFTER teardown returns.
  const sharedStackSiblings = new Set(await findWipeTargetsSharingPreservedStack(toTeardown, preserveDisks, jobLog));
  await clearSignaturesExcludingSharedStacks(toTeardown, sharedStackSiblings, summary, jobLog);

  await sweepAndValidate(toTeardown, preserveDisks, summary, jobLog);

  await runIgnore('udevadm', ['settle', '--timeout=30'], 35_000);

  await jobLog.info(
    `Holder teardown complete: ${summary.crypt_closed.length} crypt, ${summary.lvm_removed.length} lvm, ${summary.vg_removed.length} vg, ${summary.raid_stopped.length} raid, ${summary.swap_deactivated.length} swap, ${summary.signatures_cleared.length} signatures cleared, ${summary.skipped_preserved.length} disks preserved`,
  );

  return summary;
}

export { parseMdadmMembers };

async function backingDisksOfPv(pv: string, disks: Set<string>): Promise<boolean> {
  if (isMdDevice(pv) && !mdPartitionParent(pv)) {
    const probe = await probeMdadmMembers(pv);
    if (!probe.ok) return true;
    for (const m of probe.members) disks.add(diskNameFromPartition(m));
    return false;
  }
  const parent = mdPartitionParent(pv);
  if (parent) {
    const probe = await probeMdadmMembers(parent);
    if (!probe.ok) return true;
    for (const m of probe.members) disks.add(diskNameFromPartition(m));
    return false;
  }
  if (isDmDevice(pv)) {
    let indeterminate = false;
    for (const leaf of await resolveDmBackingDevices(pv)) {
      if (isMdDevice(leaf)) {
        const probe = await probeMdadmMembers(leaf);
        if (!probe.ok) {
          indeterminate = true;
          continue;
        }
        for (const m of probe.members) disks.add(diskNameFromPartition(m));
      } else {
        disks.add(diskNameFromPartition(leaf));
      }
    }
    return indeterminate;
  }
  disks.add(diskNameFromPartition(pv));
  return false;
}

export async function backingDisksOf(node: HolderNode): Promise<{ disks: Set<string>; indeterminate: boolean }> {
  const disks = new Set<string>();
  let indeterminate = false;
  if (node.layer_type === 'raid') {
    const probe = await probeMdadmMembers(`/dev/${node.name}`);
    if (!probe.ok) indeterminate = true;
    else for (const m of probe.members) disks.add(diskNameFromPartition(m));
  } else if (node.layer_type === 'lvm') {
    const vgName = await vgNameOfDmNode(node.name);
    if (vgName) {
      const pvsRaw = await runIgnore('pvs', ['--noheadings', '-o', 'pv_name', '--select', `vg_name=${vgName}`]);
      const pvols = pvsRaw
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const pv of pvols) {
        if (await backingDisksOfPv(pv, disks)) indeterminate = true;
      }
    }
    for (const leaf of await resolveDmBackingDevices(`/dev/${node.name}`)) {
      if (isMdDevice(leaf)) {
        const probe = await probeMdadmMembers(leaf);
        if (!probe.ok) indeterminate = true;
        else for (const m of probe.members) disks.add(diskNameFromPartition(m));
      } else {
        disks.add(diskNameFromPartition(leaf));
      }
    }
  } else if (node.layer_type === 'crypt') {
    for (const leaf of await resolveDmBackingDevices(`/dev/${node.name}`)) {
      if (isMdDevice(leaf)) {
        const probe = await probeMdadmMembers(leaf);
        if (!probe.ok) indeterminate = true;
        else for (const m of probe.members) disks.add(diskNameFromPartition(m));
      } else {
        disks.add(diskNameFromPartition(leaf));
      }
    }
  }
  return { disks, indeterminate };
}

// A wipe-target sharing a RAID/VG/crypt stack with a preserved disk must NOT be raw-wiped — teardown skips the shared stack, but a raw wipe of the sibling still corrupts it.
export async function findWipeTargetsSharingPreservedStack(
  wipeDiskNames: readonly string[],
  preserveDiskNames: ReadonlySet<string>,
  jobLog: JobLog = makeJobLog(),
): Promise<string[]> {
  if (preserveDiskNames.size === 0 || wipeDiskNames.length === 0) return [];
  const wipeSet = new Set(wipeDiskNames);
  const shared = new Set<string>();
  for (const pDisk of preserveDiskNames) {
    const tree = await discoverHolders(pDisk, 0, jobLog);
    if (!tree) continue;
    for (const node of flattenTree(tree)) {
      if (node.layer_type !== 'raid' && node.layer_type !== 'lvm' && node.layer_type !== 'crypt') continue;
      const { disks: backing, indeterminate } = await backingDisksOf(node);
      if (indeterminate) {
        await jobLog.warn(
          `PRESERVE: cannot enumerate backing disks for ${node.layer_type} ${node.name} on preserved disk ${pDisk} — excluding all wipe targets to avoid corrupting the shared array`,
        );
        for (const d of wipeDiskNames) {
          if (d !== pDisk) shared.add(d);
        }
        continue;
      }
      if (!backing.has(pDisk)) continue;
      for (const d of backing) {
        if (d !== pDisk && wipeSet.has(d)) shared.add(d);
      }
    }
  }
  return [...shared];
}

export function registerHolderTeardown(): void {
  registerOperation(
    'storage.teardownHolders',
    async ({ disks, preserve_disks }: { disks: string[]; preserve_disks?: string[] }) => {
      return teardownDisks(disks, new Set(preserve_disks ?? []));
    },
  );
}
