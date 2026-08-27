import type { OperationInput, OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import { callHandler } from '../../dispatch/call-handler';
import { registerOperation, type HandlerContext } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { AGENT_VERSION } from '../../version';
import { findWipeTargetsSharingPreservedStack, type TeardownSummary } from './teardown-holders';
import {
  classifyDiskWipe,
  validateWipe,
  writeValidationMarkers,
  type ValidationMarker,
  type ValidationResult,
} from './validate-wipe';
import { isControllerWideNvmeSanitize, nvmeController, waitForReadReady } from './wipe';

const logger = makeLogger('storage.wipeDisks');

const SHARED_STACK_SKIP_REASON = 'shares a RAID/VG stack with a preserved disk';
const HEARTBEAT_INTERVAL_MS = 30_000;

// 'full' is the PROVISION wipe: every physical disk is sanitized so a fresh tenant never inherits a prior tenant's residual data.
type Mode = 'selective' | 'full';

interface Blockdevice {
  name: string;
  rota: boolean;
  type: string;
  size: number;
  ro: boolean;
  model: string | null;
  serial: string | null;
  wwn?: string | undefined;
  tran: string | null;
  mountpoints?: (string | null)[] | undefined;
}

interface OptimalOsDisk {
  name: string;
  size: number | null;
  type: 'nvme' | 'ssd' | 'hdd';
}

type WipeMethods = Record<string, string>;

type WipeErrors = Record<string, { message: string; stderr?: string }>;

function extractStderr(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.length > 0) {
    return err.stderr;
  }
  return undefined;
}

export function diskMediaType(disk: Blockdevice): 'NVMe' | 'SSD' | 'HDD' {
  if (disk.name.includes('nvme')) return 'NVMe';
  if (!disk.rota) return 'SSD';
  return 'HDD';
}

const METHOD_CLASSIFICATIONS: ReadonlyArray<[string, 'purge' | 'clear' | 'best-effort' | 'none']> = [
  ['Purge', 'purge'],
  ['Clear', 'clear'],
  ['best-effort', 'best-effort'],
  ['development', 'none'],
];

export function classifyMethod(technique: string): 'purge' | 'clear' | 'best-effort' | 'none' | 'unknown' {
  for (const [keyword, cls] of METHOD_CLASSIFICATIONS) {
    if (technique.includes(keyword)) return cls;
  }
  return 'unknown';
}

export function classifyDiskType(name: string, rota: boolean): 'nvme' | 'ssd' | 'rotational' {
  if (name.startsWith('nvme')) return 'nvme';
  if (!rota) return 'ssd';
  return 'rotational';
}

export function sizeHuman(sizeBytes: number): string {
  const gb = sizeBytes / 1024 ** 3;
  return `${gb.toFixed(1)}GB`;
}

export function wipePhaseProgress(completedCount: number, totalCount: number): number {
  return totalCount === 0 ? 0.9 : (completedCount / totalCount) * 0.9;
}

function makeCall(ctx: HandlerContext) {
  return <N extends OperationName>(op: N, input: OperationInput<N>): Promise<OperationOutput<N>> =>
    callHandler(op, input, ctx);
}

async function clearRaidMetadata(diskName: string): Promise<void> {
  const dev = `/dev/${diskName}`;
  try {
    await run('mdadm', ['--zero-superblock', dev], {
      timeout_ms: 30_000,
      quiet_nonzero: true,
    });
  } catch (error) {
    logger.warn('mdadm zero-superblock failed', { disk: diskName, error: getErrorMessage(error) });
  }
}

export function updateOptimalOsDisk(current: OptimalOsDisk | null, disk: Blockdevice): OptimalOsDisk | null {
  const size = disk.size;

  if (disk.name.startsWith('nvme')) {
    if (
      !current ||
      current.type === 'hdd' ||
      current.type === 'ssd' ||
      (current.type === 'nvme' && (current.size ?? 0) < size)
    ) {
      return { name: disk.name, size, type: 'nvme' };
    }
    return current;
  }

  if (!disk.rota) {
    if (!current || current.type === 'hdd' || (current.type === 'ssd' && (current.size ?? 0) < size)) {
      return { name: disk.name, size, type: 'ssd' };
    }
    return current;
  }

  if (!current) {
    return { name: disk.name, size, type: 'hdd' };
  }
  return current;
}

export function buildSanitizationReport(args: {
  mode: Mode;
  environment?: string;
  startedAt: Date;
  completedAt: Date;
  durationSeconds: number;
  teardownResult: TeardownSummary;
  disksToWipe: Blockdevice[];
  preservedDiskInfo: Blockdevice[];
  skippedDisks: Array<{ name: string; reason: string }>;
  requestedWipeCount: number;
  allDiskNames?: string[];
  postTeardownDiskNames?: string[];
  // Operator wipe=false names (selective only): distinguishes a vanished WIPE target (fail closed) from a legitimately-unsanitized preserved disk.
  preserveDiskNames?: string[];
  validationResults: Record<string, ValidationResult | { result: 'not_validated' }>;
  wipeMethods: WipeMethods;
  wipeErrors?: WipeErrors;
  jobId: string;
  toolVersion: string;
}) {
  const {
    mode,
    environment = 'production',
    startedAt,
    completedAt,
    durationSeconds,
    teardownResult,
    disksToWipe,
    preservedDiskInfo,
    skippedDisks,
    requestedWipeCount,
    allDiskNames = [],
    postTeardownDiskNames = [],
    preserveDiskNames = [],
    validationResults,
    wipeMethods,
    wipeErrors,
    jobId,
    toolVersion,
  } = args;

  const isProd = environment === 'production';

  let overallResult: 'pass' | 'fail' = 'pass';

  // Full mode only (selective derives its set from the layout): a disk present before teardown but absent after would land in neither `disks` nor `skipped_disks` and be certified 'pass' while never sanitized — returning a prior tenant's unwiped data to inventory; report it and fail closed.
  const reconciledSkips = [...skippedDisks];
  if (mode === 'full') {
    const postTeardownSet = new Set(postTeardownDiskNames);
    const preTeardownSet = new Set(allDiskNames);
    const accountedFor = new Set<string>([...disksToWipe.map((d) => d.name), ...skippedDisks.map((s) => s.name)]);
    for (const name of allDiskNames) {
      if (accountedFor.has(name)) continue;
      const reason = postTeardownSet.has(name)
        ? 'present after teardown but neither sanitized nor skipped'
        : 'disappeared after teardown — not sanitized, not re-discovered';
      reconciledSkips.push({ name, reason });
      overallResult = 'fail';
    }
    // Opposite direction: a disk exposed as a top-level device ONLY after teardown (member of a dissolved multipath/dm/fakeraid container) is in no set; full mode requires EVERY physical disk sanitized, so fail closed.
    for (const name of postTeardownDiskNames) {
      if (preTeardownSet.has(name) || accountedFor.has(name)) continue;
      reconciledSkips.push({
        name,
        reason: 'appeared after teardown — not in pre-teardown enumeration, not sanitized',
      });
      overallResult = 'fail';
    }
  } else if (mode === 'selective') {
    // A wipe=true target that vanished from post-teardown discovery lands in neither `disks` nor `skipped_disks` and would be silently certified 'pass' — report it and fail closed.
    const preserveSet = new Set(preserveDiskNames);
    const accountedFor = new Set<string>([...disksToWipe.map((d) => d.name), ...skippedDisks.map((s) => s.name)]);
    for (const name of allDiskNames) {
      if (preserveSet.has(name) || accountedFor.has(name)) continue;
      reconciledSkips.push({
        name,
        reason: 'requested wipe target absent from post-teardown discovery — not sanitized',
      });
      overallResult = 'fail';
    }
  }

  // A read-only device still carries readable residual data and can be re-enabled — passing it would hand a fresh tenant the prior tenant's data; full mode must fail closed on any read-only skip (selective legitimately excludes disks).
  if (mode === 'full' && reconciledSkips.some((s) => s.reason === 'read-only device')) {
    overallResult = 'fail';
  }
  const disks = disksToWipe.map((disk) => {
    const name = disk.name;
    const technique = wipeMethods[name] ?? 'unknown';
    const method = classifyMethod(technique);
    const validation: ValidationResult | { result: 'not_validated' } = validationResults[name] ?? {
      result: 'not_validated',
    };

    const isDevRotationalSkip = !isProd && (disk.rota ?? false);
    const diskResult = classifyDiskWipe({
      technique,
      validationResult: validation.result,
      isDevRotationalSkip,
    });
    if (diskResult === 'fail') {
      overallResult = 'fail';
    }

    const errorRecord = wipeErrors?.[name] ?? null;
    const diagnosticError =
      technique === 'unknown' && errorRecord === null
        ? { message: 'no wipe technique succeeded; disk was not recorded in wipe results' }
        : errorRecord;

    return {
      name,
      device_path: `/dev/${name}`,
      media_type: diskMediaType(disk),
      model: disk.model || null,
      serial: disk.serial || null,
      wwn: disk.wwn || null,
      transport: disk.tran || null,
      size_bytes: disk.size ?? 0,
      size_human: sizeHuman(disk.size ?? 0),
      rotational: disk.rota ?? false,
      sanitization_method: method,
      sanitization_technique: technique,
      result: diskResult,
      verification: validation,
      wipe_error: diagnosticError,
    };
  });

  // Full mode with an empty wipe set sanitized NOTHING — never a NIST 800-88 success; fail closed.
  if (mode === 'full' && disks.length === 0) {
    overallResult = 'fail';
  }

  if (mode === 'selective' && disks.length === 0 && requestedWipeCount > 0) {
    overallResult = 'fail';
  }

  const preservedDisks = preservedDiskInfo.map((disk) => ({
    name: disk.name,
    device_path: `/dev/${disk.name}`,
    media_type: diskMediaType(disk),
    model: disk.model || null,
    serial: disk.serial || null,
    wwn: disk.wwn || null,
    size_bytes: disk.size ?? 0,
    reason: 'wipe=false in disk_layouts',
  }));

  return {
    version: '1.0' as const,
    standards_reference: ['NIST SP 800-88r2 (September 2025)', 'IEEE 2883 (2022)', 'ISO/IEC 27040 (2024)'],
    job_id: jobId,
    mode,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_seconds: durationSeconds,
    overall_result: overallResult,
    tool: {
      name: 'brokkr-bridge',
      version: toolVersion,
    },
    holder_teardown: teardownResult,
    disks,
    preserved_disks: preservedDisks,
    skipped_disks: reconciledSkips,
  };
}

export function registerWipeDisks(): void {
  registerOperation('storage.wipeDisks', async ({ disk_layouts, environment, full_wipe, job_id }, ctx) => {
    const call = makeCall(ctx);
    ctx.reportProgress(0, 'starting');

    const startedAt = new Date();
    const startMonotonic = Date.now();
    const hasLayouts = !full_wipe && Array.isArray(disk_layouts) && disk_layouts.length > 0;
    const mode: Mode = hasLayouts ? 'selective' : 'full';

    let wipeDiskNames: string[];
    const preserveDiskNames = new Set<string>();
    let allDiskNames: string[];

    if (hasLayouts) {
      const resolved = await call('storage.resolveDisks', { disk_layouts });

      const wipeSet = new Set<string>();
      for (const layout of resolved.layouts) {
        const layoutDisks = layout.disks ?? [];
        if (layout.wipe) {
          for (const d of layoutDisks) wipeSet.add(d);
        } else {
          for (const d of layoutDisks) preserveDiskNames.add(d);
        }
      }
      for (const d of preserveDiskNames) wipeSet.delete(d);
      wipeDiskNames = [...wipeSet];
      allDiskNames = [...new Set([...wipeDiskNames, ...preserveDiskNames])];
    } else {
      const discovered = await call('storage.discoverDisks', {});
      allDiskNames = discovered.blockdevices.map((d) => d.name);
      wipeDiskNames = [...allDiskNames];
    }
    ctx.reportProgress(0.01, 'discovery complete');

    await call('storage.unmountDisks', {});
    ctx.reportProgress(0.02, 'unmount complete');

    const teardownResult = await call('storage.teardownHolders', {
      disks: allDiskNames,
      preserve_disks: [...preserveDiskNames],
    });
    ctx.reportProgress(0.03, 'teardown complete');

    const postTeardown = await call('storage.discoverDisks', {});
    ctx.reportProgress(0.04, 'rediscovery complete');

    // requestedWipeCount is captured BEFORE protective exclusions so the report can fail closed when the whole set was dropped.
    const requestedWipeCount = wipeDiskNames.length;
    const sharedStackDisks = new Set(await findWipeTargetsSharingPreservedStack(wipeDiskNames, preserveDiskNames));
    if (sharedStackDisks.size > 0) {
      logger.warn('excluding wipe targets that share a preserved RAID/VG stack', {
        disks: [...sharedStackDisks],
      });
      wipeDiskNames = wipeDiskNames.filter((d) => !sharedStackDisks.has(d));
    }

    const disksToWipe = postTeardown.blockdevices.filter((d) => wipeDiskNames.includes(d.name) && d.size > 0 && !d.ro);
    const preservedDiskInfo = postTeardown.blockdevices.filter((d) => preserveDiskNames.has(d.name));
    const skippedDisks = postTeardown.blockdevices
      .filter((d) => wipeDiskNames.includes(d.name) && (d.size === 0 || d.ro))
      .map((d) => ({
        name: d.name,
        reason: d.ro ? 'read-only device' : 'zero-size device',
      }))
      .concat(
        [...sharedStackDisks].map((name) => ({
          name,
          reason: SHARED_STACK_SKIP_REASON,
        })),
      );

    const isProd = environment === 'production';
    const validationMap: Record<string, ValidationMarker[]> = {};
    for (const disk of disksToWipe) {
      if (disk.rota && !isProd) continue;
      const markers = await writeValidationMarkers(disk.name);
      if (markers.length > 0) validationMap[disk.name] = markers;
    }
    ctx.reportProgress(0.05, 'validation markers complete');

    const raid = await call('storage.detectRaidControllers', {});
    ctx.reportProgress(0.06, 'RAID controller detection complete');

    // "Spared" derives from post-teardown discovery, NOT preserveDiskNames — a namespace the operator never listed in any group would otherwise be silently erased by controller-wide Sanitize.
    const wipeNameSet = new Set(wipeDiskNames);
    const spareNvmeControllers = new Set<string>();
    for (const dev of postTeardown.blockdevices) {
      if (!dev.name.startsWith('nvme')) continue;
      if (!wipeNameSet.has(dev.name)) spareNvmeControllers.add(nvmeController(dev.name));
    }

    const wipeMethods: WipeMethods = {};
    const wipeErrors: WipeErrors = {};
    let optimalOsDisk: OptimalOsDisk | null = null;

    const wipeSibling = async (sibling: Blockdevice, is_raid: boolean): Promise<void> => {
      try {
        const out = await call('storage.wipeDisk', {
          disk_name: sibling.name,
          disk_type: 'nvme',
          is_raid_controller: is_raid,
          environment,
          controller_has_preserved_sibling: true,
        });
        wipeMethods[sibling.name] = out.method_used;
        await call('storage.clearGpt', { disk_name: sibling.name });
        await clearRaidMetadata(sibling.name);
        optimalOsDisk = updateOptimalOsDisk(optimalOsDisk, sibling);
      } catch (err) {
        const message = getErrorMessage(err);
        const stderr = extractStderr(err);
        logger.error('per-disk wipe failed', {
          disk: sibling.name,
          disk_type: 'nvme',
          is_raid_controller: is_raid,
          phase: 'wipe-sibling',
          message,
          ...(stderr !== undefined ? { stderr } : {}),
        });
        wipeErrors[sibling.name] = stderr !== undefined ? { message, stderr } : { message };
      }
    };

    const nvmeSiblingsOfPrimary = new Map<string, Blockdevice[]>();
    const wipeTargets: Blockdevice[] = [];
    const primaryByController = new Map<string, Blockdevice>();
    for (const disk of disksToWipe) {
      const ctrl = nvmeController(disk.name);
      if (classifyDiskType(disk.name, disk.rota) !== 'nvme' || spareNvmeControllers.has(ctrl)) {
        wipeTargets.push(disk);
        continue;
      }
      const primary = primaryByController.get(ctrl);
      if (!primary) {
        primaryByController.set(ctrl, disk);
        nvmeSiblingsOfPrimary.set(disk.name, []);
        wipeTargets.push(disk);
      } else {
        nvmeSiblingsOfPrimary.get(primary.name)!.push(disk);
      }
    }

    let completedWipeCount = 0;
    const wipeHeartbeat = setInterval(() => {
      ctx.reportProgress(wipePhaseProgress(completedWipeCount, wipeTargets.length), 'wipe in progress');
    }, HEARTBEAT_INTERVAL_MS);
    try {
      await Promise.all(
        wipeTargets.map(async (disk) => {
          try {
            const disk_type = classifyDiskType(disk.name, disk.rota);
            const is_raid = raid.disk_raid_status[disk.name] ?? false;
            const controller_has_preserved_sibling =
              disk_type === 'nvme' && spareNvmeControllers.has(nvmeController(disk.name));
            const siblings = nvmeSiblingsOfPrimary.get(disk.name) ?? [];
            try {
              const out = await call('storage.wipeDisk', {
                disk_name: disk.name,
                disk_type,
                is_raid_controller: is_raid,
                environment,
                controller_has_preserved_sibling,
              });
              wipeMethods[disk.name] = out.method_used;
              await call('storage.clearGpt', { disk_name: disk.name });
              await clearRaidMetadata(disk.name);
              optimalOsDisk = updateOptimalOsDisk(optimalOsDisk, disk);

              if (isControllerWideNvmeSanitize(out.method_used)) {
                // Sanitize puts every namespace in the restricted-read window but only the primary waited; wait per sibling or validateWipe false-fails on EIO.
                for (const sibling of siblings) {
                  await waitForReadReady(sibling.name);
                  wipeMethods[sibling.name] = out.method_used;
                  optimalOsDisk = updateOptimalOsDisk(optimalOsDisk, sibling);
                }
              } else {
                await Promise.all(siblings.map((sibling) => wipeSibling(sibling, is_raid)));
              }
            } catch (err) {
              const message = getErrorMessage(err);
              const stderr = extractStderr(err);
              logger.error('per-disk wipe failed', {
                disk: disk.name,
                disk_type,
                is_raid_controller: is_raid,
                phase: 'wipe-concurrent',
                message,
                ...(stderr !== undefined ? { stderr } : {}),
              });
              wipeErrors[disk.name] = stderr !== undefined ? { message, stderr } : { message };
              await Promise.all(siblings.map((sibling) => wipeSibling(sibling, is_raid)));
            }
          } finally {
            completedWipeCount += 1;
          }
        }),
      );
    } finally {
      clearInterval(wipeHeartbeat);
    }

    const validationResults: Record<string, ValidationResult | { result: 'not_validated' }> = {};
    const validationEntries = Object.entries(validationMap);
    let completedValidationCount = 0;
    const validationHeartbeat = setInterval(() => {
      const validationRatio = validationEntries.length === 0 ? 1 : completedValidationCount / validationEntries.length;
      ctx.reportProgress(0.9 + validationRatio * 0.1, 'validation in progress');
    }, HEARTBEAT_INTERVAL_MS);
    try {
      for (const [diskName, markers] of validationEntries) {
        const method = wipeMethods[diskName] ?? 'unknown';
        try {
          validationResults[diskName] = await validateWipe(diskName, markers, method);
        } catch (error) {
          logger.error('validation threw; recording disk as not_validated rather than aborting the operation', {
            disk: diskName,
            err: getErrorMessage(error),
          });
          validationResults[diskName] = { result: 'not_validated' };
        } finally {
          completedValidationCount += 1;
        }
      }
    } finally {
      clearInterval(validationHeartbeat);
    }
    ctx.reportProgress(1, 'validation complete');

    const completedAt = new Date();
    const durationSeconds = Math.round((Date.now() - startMonotonic) / 1000);

    const sanitization_report = buildSanitizationReport({
      mode,
      environment,
      startedAt,
      completedAt,
      durationSeconds,
      teardownResult,
      disksToWipe,
      preservedDiskInfo,
      skippedDisks,
      requestedWipeCount,
      allDiskNames,
      postTeardownDiskNames: postTeardown.blockdevices.map((d) => d.name),
      preserveDiskNames: [...preserveDiskNames],
      validationResults,
      wipeMethods,
      wipeErrors,
      jobId: job_id || ctx.job_id || '',
      toolVersion: AGENT_VERSION,
    });

    return { sanitization_report, optimal_os_disk: optimalOsDisk };
  });
}
