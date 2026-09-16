/**
 * Step registry — the catalog of assemblable building blocks a plan composes.
 *
 * Action steps wrap the existing reusable helpers in `../lifecycle-helpers`.
 * Verification steps (e.g. `verify-os`) lift the assertion logic that used to
 * live inline in a single `test-*.test.ts` so it can be composed into any plan.
 *
 * Add a step by calling `register(defineStep({...}))`.
 */

import { expect } from 'vitest';
import { z } from 'zod';

import {
  bootMacFromEnv,
  buildDiskLayouts,
  buildProvisionPayload,
  explicitDeviceIdFromEnv,
  pollUntil,
  type DiskLayoutEntry,
  type FleetPlanes,
  type StorageLayouts,
} from '../helpers';
import { readBootTrailLine } from '../lab-boot-trail';
import {
  OS_SLUG,
  awaitDiscoveryReady,
  awaitProvisioned,
  classifyBoot,
  endRentalToInventory,
  powerCycle,
  step,
} from '../lifecycle-helpers';
import {
  awaitSpokeState,
  awaitWorkingSpoke,
  controlCenterReachable,
  controlSpoke,
  deviceLockHeld,
  getPlanSnapshot,
  planCompletedStepCount,
  runningSpokes,
} from '../spoke-ha';
import { VMClient, userForSlug } from '../vm-client';
import type { PlanContext, Step } from './types';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Type-erased step: params are parsed inside `exec`, so the registry is homogeneous. */
interface RegisteredStep {
  id: string;
  label: string;
  parseParams(raw: unknown): unknown;
  exec(ctx: PlanContext, rawParams: unknown): Promise<void>;
}

/** Close over a step's `parseParams` + `run` so the registry can hold any param shape without casts. */
function defineStep<P>(def: Step<P>): RegisteredStep {
  return {
    id: def.id,
    label: def.label,
    parseParams: def.parseParams,
    exec: (ctx, raw) => def.run(ctx, def.parseParams(raw)),
  };
}

const registry = new Map<string, RegisteredStep>();

function register(s: RegisteredStep): void {
  if (registry.has(s.id)) throw new Error(`duplicate step id '${s.id}'`);
  registry.set(s.id, s);
}

/** Resolve a step by id, or throw listing the known ids. */
export function getStep(id: string): RegisteredStep {
  const s = registry.get(id);
  if (!s) throw new Error(`unknown step '${id}' (known: ${[...registry.keys()].join(', ')})`);
  return s;
}

/** The assemblable steps, for the plan builder / UI. */
export function stepCatalog(): { id: string; label: string }[] {
  return [...registry.values()].map(({ id, label }) => ({ id, label }));
}

// ---------------------------------------------------------------------------
// Param schemas (plan params are external JSON)
// ---------------------------------------------------------------------------

// passthrough: a disk group carries free-form extra keys the picker round-trips.
const diskGroupSchema = z
  .object({
    group: z.string().optional(),
    config: z.string().optional(),
    file_system: z.string().optional(),
    mountpoint: z.string().optional(),
  })
  .passthrough();

const diskLayoutSchema = z
  .object({
    label: z.string().optional(),
    os: diskGroupSchema.optional(),
    data: z.array(diskGroupSchema).optional(),
  })
  .strict();

function provisionParamsSchema(defaultName: string) {
  return z
    .object({
      deploymentName: z.string().min(1).default(defaultName),
      osSlug: z.string().optional(),
      customizations: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      cloudInit: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      ipxeUrl: z.string().optional(),
      diskLayout: diskLayoutSchema.optional(),
    })
    .strict();
}

/**
 * The bench box is Ubuntu-only by operator mandate. `verify-os` asserts RELATIVE to the slug, so
 * without this a debian-* slug would install and then verify green.
 */
export function requireUbuntuOnBareMetal(planes: FleetPlanes, slug: string, kind: string): void {
  if (planes.baremetal && !slug.startsWith('ubuntu-')) {
    throw new Error(
      `refusing to ${kind} the bare-metal box with base '${slug}': bare-metal runs must use an ubuntu-* base`,
    );
  }
}

/**
 * Bare-metal netplan degrades to DHCP, so the lease the deployed OS gets can differ from the one
 * discovery had — a stale ctx.dataIp turns every later SSH step into an opaque timeout.
 */
async function refreshBareMetalDataIp(ctx: PlanContext): Promise<void> {
  if (!ctx.fleet.planes.baremetal) return;
  const bootMac = bootMacFromEnv();
  if (!bootMac) return;
  const current = await ctx.hubDb.getDataIpByBootMac(bootMac);
  if (!current || current === ctx.dataIp) return;
  step(`bare-metal data IP moved ${ctx.dataIp} -> ${current} after deploy`);
  ctx.dataIp = current;
}

/** Flatten a customizations map `{group: slug | [slug]}` into a flat slug list. */
function flattenCustomizations(c: Record<string, string | string[]>): string[] {
  return Object.values(c).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

// ---------------------------------------------------------------------------
// Action steps — provision / reprovision
// ---------------------------------------------------------------------------

type ProvisionParams = { kind: 'provision' | 'reprovision' } & z.infer<ReturnType<typeof provisionParamsSchema>>;

function provisionStep(kind: 'provision' | 'reprovision', defaultName: string): Step<ProvisionParams> {
  const schema = provisionParamsSchema(defaultName);
  return {
    id: kind,
    label: kind === 'provision' ? 'Provision' : 'Reprovision',
    parseParams(raw): ProvisionParams {
      return { kind, ...schema.parse(raw ?? {}) };
    },
    async run(ctx, params) {
      const resolvedSlug = params.osSlug ?? OS_SLUG;
      step(`${params.kind}: base OS ${resolvedSlug}`, { metadata: { osSlug: resolvedSlug, planes: ctx.fleet.planes } });
      requireUbuntuOnBareMetal(ctx.fleet.planes, resolvedSlug, params.kind);
      const jobId = await awaitProvisioned(ctx.hubAdmin, ctx.hubDb, ctx.bridgeRedis, ctx.dataIp, ctx.deviceId, {
        kind: params.kind,
        deploymentName: params.deploymentName,
        osSlug: params.osSlug,
        customizations: params.customizations,
        cloudInit: params.cloudInit,
        ipxeUrl: params.ipxeUrl,
        diskLayout: params.diskLayout,
      });
      ctx.scratch.lastJobId = jobId;
      await refreshBareMetalDataIp(ctx);
      // Stash what later verify steps need: the booted slug (verify-os), the
      // customization slugs (verify-layers), and the disk selection (verify-disk).
      ctx.scratch.osSlug = params.osSlug ?? OS_SLUG;
      ctx.scratch.layerSlugs = params.customizations ? flattenCustomizations(params.customizations) : [];
      ctx.scratch.diskLayout = params.diskLayout;
      // Stash a string form even for object user-data, so verify-cloud-init's
      // section checks run instead of silently skipping on a non-string value.
      ctx.scratch.cloudInit =
        params.cloudInit === undefined
          ? undefined
          : typeof params.cloudInit === 'string'
            ? params.cloudInit
            : JSON.stringify(params.cloudInit);
    },
  };
}

// ---------------------------------------------------------------------------
// Action steps — power-cycle / end-rental
// ---------------------------------------------------------------------------

const powerCycleStep: Step = {
  id: 'power-cycle',
  label: 'Power cycle',
  parseParams() {},
  async run(ctx) {
    await powerCycle(ctx.hubAdmin, ctx.hubDb, ctx.dataIp, ctx.deviceId, {
      bareMetal: explicitDeviceIdFromEnv() !== null,
      bootTrail: () => readBootTrailLine(ctx.deviceId),
    });
  },
};

const endRentalStep: Step = {
  id: 'end-rental',
  label: 'End rental → INVENTORY',
  parseParams() {},
  async run(ctx) {
    await endRentalToInventory(ctx.hubAdmin, ctx.hubDb, ctx.deviceId);
  },
};

// ---------------------------------------------------------------------------
// Verification step — verify-os
// ---------------------------------------------------------------------------

/** Value of a key in `/etc/os-release` (handles quoted + bare forms). */
function osrel(text: string, key: string): string {
  const re = new RegExp(`^${key}=(?:"([^"]*)"|([^\\s]*))`, 'm');
  const m = text.match(re);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').trim();
}

/** Leading dotted-number of a version string (`'24.04 LTS'` -> `'24.04'`). */
function normVer(v: string): string {
  const m = v.trim().match(/^\d+(?:\.\d+)*/);
  return m ? m[0] : v.trim();
}

const serverDetailSchema = z
  .object({
    availableBaseLayers: z
      .array(z.object({ slug: z.string().optional(), version: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/**
 * Expected `[distro, version]` for a base OS slug from the hub server detail,
 * falling back to parsing the slug (e.g. `ubuntu-24.04`).
 */
function expectedOs(serverBody: unknown, slug: string): [string | null, string | null] {
  const parsed = serverDetailSchema.safeParse(serverBody);
  const bases = parsed.success ? (parsed.data.availableBaseLayers ?? []) : [];
  for (const b of bases) {
    if (b.slug === slug && b.version) return [slug.split('-')[0] ?? null, b.version];
  }
  const parts = slug.split('-');
  if (parts.length >= 2) {
    // Second segment may be a codename (e.g. `noble`), which doesn't map to a
    // VERSION_ID without a lookup table — only treat a numeric segment as a version.
    const ver = /^\d/.test(parts[1] ?? '') ? (parts[1] ?? null) : null;
    return [parts[0] ?? null, ver];
  }
  return [null, null];
}

const verifyOsParamsSchema = z.object({ osSlug: z.string().optional() }).strict();
type VerifyOsParams = z.infer<typeof verifyOsParamsSchema>;

const verifyOsStep: Step<VerifyOsParams> = {
  id: 'verify-os',
  label: 'Verify booted OS',
  parseParams(raw): VerifyOsParams {
    return verifyOsParamsSchema.parse(raw ?? {});
  },
  async run(ctx, params) {
    const slug = params.osSlug ?? (typeof ctx.scratch.osSlug === 'string' ? ctx.scratch.osSlug : OS_SLUG);
    const ip = ctx.dataIp;

    const { status, body } = await ctx.hubAdmin.getServer(ctx.deviceId);
    expect(status, `getServer(${ctx.deviceId}) -> ${status}`).toBe(200);
    const [distro, version] = expectedOs(body, slug);

    step(`verify-os: settling on installed OS at ${ip} (expect ${distro ?? '?'} ${version ?? '?'})...`);
    // PROVISIONED implies phone-home fired, but the VM still has to reboot off
    // brokkr-live into the installed disk and sshd may bind a beat later.
    const boot = await pollUntil(
      () => classifyBoot(ip, slug),
      (s) => s === 'os' || s === 'brokkr-live',
      { timeout: 420_000, interval: 10_000 },
    );
    expect(boot, `${slug}: device booted '${boot}', not the installed OS`).toBe('os');

    const vm = new VMClient(ip, userForSlug(slug));
    const result = await vm.run('cat /etc/os-release', 30);
    const text = result.stdout || result.stderr;
    const gotId = osrel(text, 'ID');
    const gotVer = osrel(text, 'VERSION_ID');
    step(`verify-os: ${slug} -> ID=${gotId} VERSION_ID=${gotVer}`);

    if (distro) {
      expect(gotId.toLowerCase(), `${slug}: distro mismatch -- booted '${gotId}', expected '${distro}'`).toBe(
        distro.toLowerCase(),
      );
    }
    if (version) {
      const exp = normVer(version);
      const got = normVer(gotVer);
      // A missing VERSION_ID yields got='' and exp.startsWith('') is always true,
      // which would pass the check vacuously — fail loudly instead.
      expect(got, `${slug}: VERSION_ID missing from /etc/os-release`).not.toBe('');
      const ok = exp === got || exp.startsWith(got) || got.startsWith(exp);
      expect(ok, `${slug}: version mismatch -- booted '${gotVer}', expected '${version}'`).toBe(true);
    }
  },
};

// ---------------------------------------------------------------------------
// Verification step — verify-layers
// ---------------------------------------------------------------------------

/** Runtime verification command(s) for a layer slug; `soft` logs a miss without failing. */
function layerChecksFor(slug: string): { cmd: string; soft: boolean }[] {
  if (slug === 'docker') return [{ cmd: 'docker --version', soft: false }];
  if (slug.startsWith('nvidia-driver')) return [{ cmd: 'nvidia-smi', soft: true }];
  if (slug.startsWith('cuda'))
    return [{ cmd: "bash -lc 'nvcc --version || ls /usr/local/cuda*/version*'", soft: true }];
  if (slug.startsWith('pytorch')) return [{ cmd: "python3 -c 'import torch; print(torch.__version__)'", soft: true }];
  if (slug === 'mellanox-ofed') return [{ cmd: "bash -lc 'ofed_info -s || modinfo mlx5_core'", soft: true }];
  if (slug === 'nvidia-container-toolkit')
    return [{ cmd: "bash -lc 'which nvidia-ctk || which nvidia-container-toolkit'", soft: true }];
  return [{ cmd: 'true', soft: true }]; // unknown slug: deploy success already asserted upstream
}

async function verifyLayer(vm: VMClient, slug: string): Promise<void> {
  for (const { cmd, soft } of layerChecksFor(slug)) {
    const result = await vm.run(cmd, 30);
    step(`verify-layers: [${slug}] ${cmd} (rc=${result.returncode})`);
    if (result.returncode === 0) return;
    if (!soft) throw new Error(`layer '${slug}': \`${cmd}\` failed rc=${result.returncode}: ${result.stderr.trim()}`);
  }
  // GPU layers can't come up without a real discovered GPU -- soft-miss is expected.
  step(`verify-layers: [${slug}] soft-miss: deploy succeeded but the layer's effect is unverified`);
}

const verifyLayersStep: Step = {
  id: 'verify-layers',
  label: 'Verify OS-customization layers',
  parseParams() {},
  async run(ctx) {
    const slugs = Array.isArray(ctx.scratch.layerSlugs)
      ? ctx.scratch.layerSlugs.filter((s) => typeof s === 'string')
      : [];
    const slug = typeof ctx.scratch.osSlug === 'string' ? ctx.scratch.osSlug : OS_SLUG;
    if (!slugs.length) {
      step('verify-layers: no customization layers selected by the preceding provision -- nothing to verify');
      return;
    }
    const vm = new VMClient(ctx.dataIp, userForSlug(slug));
    for (const s of slugs) await verifyLayer(vm, s);
  },
};

// ---------------------------------------------------------------------------
// Verification step — verify-disk
// ---------------------------------------------------------------------------

/** Resolve a findmnt SOURCE to its backing md device name, or null. */
async function mdFromSource(vm: VMClient, source: string): Promise<string | null> {
  const leaf = source.split('/').pop() ?? '';
  if (leaf.startsWith('md')) return leaf;
  const out = await vm.run(`lsblk -nso NAME ${source} 2>/dev/null`, 20);
  for (const line of (out.stdout ?? '').split('\n')) {
    const name = line.replace(/^[`|'\- ]+/, '').trim();
    if (name.startsWith('md')) return name;
  }
  return null;
}

async function verifyDiskLayout(vm: VMClient, entries: DiskLayoutEntry[]): Promise<void> {
  const mdstat = await vm.run('cat /proc/mdstat', 20);
  const lvs = await vm.run("sudo lvs --noheadings 2>/dev/null; echo '---'; sudo vgs --noheadings 2>/dev/null", 30);

  for (const { mountpoint, format: fs, config } of entries) {
    const fm = await vm.run(`findmnt -no FSTYPE,SOURCE --target ${mountpoint}`, 20);
    const fmOut = (fm.stdout ?? '').trim();
    step(`verify-disk: findmnt ${mountpoint} -> ${fmOut || '(none)'}`);
    expect(fm.returncode, `mountpoint ${mountpoint} not mounted (findmnt failed)`).toBe(0);
    expect(fmOut, `mountpoint ${mountpoint} not mounted (findmnt empty)`).toBeTruthy();

    const parts = fmOut.split(/\s+/);
    const gotFs = parts[0] ?? '';
    const source = parts[1] ?? '';
    expect(gotFs, `${mountpoint} filesystem mismatch`).toBe(fs);

    if (config.startsWith('raid')) {
      const level = config.replace('raid', '');
      expect(
        source.includes('md') || (mdstat.stdout ?? '').includes('md'),
        `${mountpoint} config=${config} but no md device backs it (source=${source})`,
      ).toBe(true);
      const md = await mdFromSource(vm, source);
      if (md) {
        const detail = await vm.run(`sudo mdadm --detail /dev/${md}`, 30);
        const detailLower = (detail.stdout || detail.stderr).trim().toLowerCase();
        expect(
          detailLower.includes(`raid${level}`),
          `${mountpoint} expected raid${level}, mdadm --detail did not show it`,
        ).toBe(true);
      }
    } else if (config === 'lvm') {
      expect(
        source.includes('mapper') || source.includes('/dev/dm-') || (source.split('/').pop() ?? '').includes('-'),
        `${mountpoint} config=lvm but source ${source} is not an LVM logical volume`,
      ).toBe(true);
      expect(
        (lvs.stdout ?? '').trim(),
        `${mountpoint} config=lvm but \`lvs\` reported no logical volumes`,
      ).toBeTruthy();
    }
    // config === 'direct': plain partition; the findmnt fs check above is sufficient.
  }
}

const verifyDiskStep: Step = {
  id: 'verify-disk',
  label: 'Verify disk layout',
  parseParams() {},
  async run(ctx) {
    const slug = typeof ctx.scratch.osSlug === 'string' ? ctx.scratch.osSlug : OS_SLUG;
    const ip = ctx.dataIp;

    const raw = await ctx.hubDb.getStorageLayouts(ctx.deviceId);
    if (!raw) throw new Error(`device ${ctx.deviceId} has no seeded storageLayouts`);
    const layouts: StorageLayouts = raw;
    const selection = ctx.scratch.diskLayout;
    const entries = buildDiskLayouts(layouts, selection === undefined ? undefined : diskLayoutSchema.parse(selection));

    step('verify-disk: settling on installed OS before probing disks...');
    const boot = await pollUntil(
      () => classifyBoot(ip, slug),
      (s) => s === 'os' || s === 'brokkr-live',
      { timeout: 420_000, interval: 10_000 },
    );
    expect(boot, `device booted '${boot}', not the installed OS`).toBe('os');

    await verifyDiskLayout(new VMClient(ip, userForSlug(slug)), entries);
  },
};

// ---------------------------------------------------------------------------
// Action steps — rescue activate / deactivate
// ---------------------------------------------------------------------------

const rescueActivateParamsSchema = z.object({ rescueOs: z.string().optional() }).strict();
type RescueActivateParams = z.infer<typeof rescueActivateParamsSchema>;

const rescueActivateStep: Step<RescueActivateParams> = {
  id: 'rescue-activate',
  label: 'Activate rescue (boot live OS)',
  parseParams(raw): RescueActivateParams {
    return rescueActivateParamsSchema.parse(raw ?? {});
  },
  async run(ctx, params) {
    const ip = ctx.dataIp;
    const depId = await ctx.hubDb.getActiveDeploymentId(ctx.deviceId);
    expect(depId, `no active deployment for ${ctx.deviceId} -- cannot activate rescue`).toBeTruthy();

    step('rescue-activate: firing rescue activate...');
    const res = await ctx.hubAdmin.rescueActivate(depId!, params.rescueOs);
    expect(res.status, `rescue activate rejected: ${JSON.stringify(res.body)}`).toBe(200);

    // Rescue is a live OS -- root SSH works, ubuntu denied (like brokkr-live).
    const boot = await pollUntil(
      () => classifyBoot(ip),
      (s) => s === 'brokkr-live',
      { timeout: 900_000, interval: 15_000 },
    );
    expect(boot, `device did not boot the rescue live OS (got ${boot})`).toBe('brokkr-live');
    const rootCheck = await new VMClient(ip, 'root').run('true');
    expect(rootCheck.returncode, 'rescue live OS not reachable as root').toBe(0);
    step('rescue-activate: live rescue OS reachable as root');
  },
};

const rescueDeactivateStep: Step = {
  id: 'rescue-deactivate',
  label: 'Exit rescue (back to installed OS)',
  parseParams() {},
  async run(ctx) {
    const ip = ctx.dataIp;
    const depId = await ctx.hubDb.getActiveDeploymentId(ctx.deviceId);
    expect(depId, `no active deployment for ${ctx.deviceId} -- cannot deactivate rescue`).toBeTruthy();

    step('rescue-deactivate: firing rescue deactivate...');
    const res = await ctx.hubAdmin.rescueDeactivate(depId!);
    expect(res.status, `rescue deactivate rejected: ${JSON.stringify(res.body)}`).toBe(200);

    const back = await pollUntil(
      () => classifyBoot(ip),
      (s) => s === 'os',
      { timeout: 600_000, interval: 15_000 },
    );
    expect(back, `device did not return to the installed OS (got ${back})`).toBe('os');
    step('rescue-deactivate: back on the installed OS');
  },
};

// ---------------------------------------------------------------------------
// Verification step — verify-cloud-init
// ---------------------------------------------------------------------------

// (marker-in-user-data, label, verify-cmd, expected-substring). Checked only when
// the marker is present, so the step adapts to whatever sections the user-data
// carries. The users/ssh section is proven by the SSH-reachability gate below.
const CLOUD_INIT_CHECKS: [string, string, string, string][] = [
  ['/etc/brokkr-e2e.txt', 'write_files', 'sudo cat /etc/brokkr-e2e.txt', 'hydra-host cloud-init e2e'],
  ['- sl', 'packages', 'dpkg -s sl', 'Status: install'],
  ['brokkr-e2e.log', 'runcmd', 'sudo cat /var/log/brokkr-e2e.log', 'cloud-init-ran'],
];

const verifyCloudInitParamsSchema = z.object({ user: z.string().optional() }).strict();
type VerifyCloudInitParams = z.infer<typeof verifyCloudInitParamsSchema>;

const verifyCloudInitStep: Step<VerifyCloudInitParams> = {
  id: 'verify-cloud-init',
  label: 'Verify cloud-init sections',
  parseParams(raw): VerifyCloudInitParams {
    return verifyCloudInitParamsSchema.parse(raw ?? {});
  },
  async run(ctx, params) {
    const user = params.user ?? 'brokkre2e';
    const cloudInit = typeof ctx.scratch.cloudInit === 'string' ? ctx.scratch.cloudInit : '';
    const ip = ctx.dataIp;
    const vm = new VMClient(ip, user);

    // SSH-as-user succeeding == the users + ssh_authorized_keys sections applied.
    step(`verify-cloud-init: awaiting SSH as ${user}@${ip} (proves users+ssh)...`);
    const reachable = await pollUntil(
      async () => (await vm.run('true', 15)).returncode === 0,
      (ok) => ok,
      { timeout: 180_000, interval: 15_000 },
    );
    expect(
      reachable,
      `cloud-init users/ssh not applied (or VM unreachable): SSH as ${user}@${ip} never succeeded`,
    ).toBe(true);

    // write_files/packages/runcmd run in cloud-init's final stage -- block on it.
    const ci = await vm.run('cloud-init status --wait', 600);
    expect(ci.returncode, `cloud-init did not reach 'done' (rc=${ci.returncode})`).toBe(0);

    let checked = 0;
    for (const [marker, name, cmd, want] of CLOUD_INIT_CHECKS) {
      if (!cloudInit.includes(marker)) continue;
      checked += 1;
      const r = await vm.run(cmd, 30);
      expect(
        (r.stdout ?? '').includes(want),
        `cloud-init ${name} not applied: \`${cmd}\` -> ${JSON.stringify(r.stdout)}`,
      ).toBe(true);
    }
    step(`verify-cloud-init: ${checked} section(s) verified (users+ssh proven by reachability)`);
  },
};

// ---------------------------------------------------------------------------
// Action step — provision-ipxe-custom (trusted-URL mode)
// ---------------------------------------------------------------------------

/** Passes the hub's trust check (https + *.hydrahost.com). Plumbing-only -- not fetched in the sim. */
const TRUSTED_IPXE_URL = 'https://boot.hydrahost.com/rescue.ipxe';

const ipxeCustomParamsSchema = z.object({ ipxeUrl: z.string().optional() }).strict();
type IpxeCustomParams = z.infer<typeof ipxeCustomParamsSchema>;

const ipxeCustomStep: Step<IpxeCustomParams> = {
  id: 'provision-ipxe-custom',
  label: 'Provision custom iPXE (URL stored)',
  parseParams(raw): IpxeCustomParams {
    return ipxeCustomParamsSchema.parse(raw ?? {});
  },
  async run(ctx, params) {
    // wipe-disks.step.ts has no ipxe_url skip, so the accepted provision below NIST-sanitizes every
    // disk and then hands boot to an external URL without installing anything.
    if (ctx.fleet.planes.baremetal) {
      throw new Error(
        'refusing to run provision-ipxe-custom against the bare-metal box: the provision saga ' +
          'full-wipes every disk and installs nothing, handing boot to an external iPXE URL',
      );
    }

    const url = params.ipxeUrl ?? TRUSTED_IPXE_URL;

    // Validator negatives (rejected before any saga work).
    const neg1 = await ctx.hubAdmin.provision(
      ctx.deviceId,
      await buildProvisionPayload(ctx.hubDb, ctx.deviceId, { osSlug: 'ipxe-custom', deploymentName: 'e2e-ipxe-neg' }),
    );
    expect(neg1.status, 'ipxe-custom without ipxeUrl must be rejected').toBe(400);
    const neg2 = await ctx.hubAdmin.provision(
      ctx.deviceId,
      await buildProvisionPayload(ctx.hubDb, ctx.deviceId, {
        osSlug: OS_SLUG,
        deploymentName: 'e2e-ipxe-neg2',
        ipxeUrl: url,
      }),
    );
    expect(neg2.status, 'ipxeUrl with a non-custom OS must be rejected').toBe(400);

    // Positive: provision ipxe-custom + url, assert the hub stored it for the chain.
    await awaitDiscoveryReady(ctx.dataIp, ctx.deviceId);
    const res = await ctx.hubAdmin.provision(
      ctx.deviceId,
      await buildProvisionPayload(ctx.hubDb, ctx.deviceId, {
        osSlug: 'ipxe-custom',
        deploymentName: 'e2e-ipxe',
        ipxeUrl: url,
      }),
    );
    expect(res.status, `ipxe-custom provision rejected: ${JSON.stringify(res.body)}`).toBe(200);

    const got = await pollUntil(
      () => ctx.bridgeRedis.getIpxeUrl(ctx.deviceId),
      (v) => v === url,
      { timeout: 60_000, interval: 3_000 },
    );
    expect(got, 'hub did not store the ipxe_url for the chain').toBe(url);
    step(`provision-ipxe-custom: ipxe_url stored (${url})`);
  },
};

// ---------------------------------------------------------------------------
// Spoke-HA steps (failover / restart-resume)
//
// These are composite: they fire a provision and, while it is mid-saga, disrupt
// the spoke working it, then await the terminal state -- the original HA tests'
// flow, encapsulated in one step rather than a generic concurrent "during" hook.
// Require >=2 HA spoke replicas; throw a clear error otherwise (Rule 12: fail loud).
// ---------------------------------------------------------------------------

async function requireHaSpokes(): Promise<void> {
  if (!(await controlCenterReachable())) {
    throw new Error('control center not reachable on :3002 -- spoke-HA steps need it to control spokes');
  }
  const spokes = await runningSpokes();
  if (spokes.length < 2) {
    throw new Error(
      `spoke-HA steps require >=2 running spokes; found ${spokes.length} (${spokes.map((s) => s.id).join(', ')}). ` +
        'Raise the zone bridge count (HA replicas) and bring the stack up.',
    );
  }
}

/** Fire a provision and return its job id once the device is PROVISIONING -- does NOT await PROVISIONED. */
async function fireProvision(ctx: PlanContext, deploymentName: string): Promise<string> {
  await awaitDiscoveryReady(ctx.dataIp, ctx.deviceId);
  const payload = await buildProvisionPayload(ctx.hubDb, ctx.deviceId, { osSlug: OS_SLUG, deploymentName });
  const res = await ctx.hubAdmin.provision(ctx.deviceId, payload);
  expect(res.status, `provision rejected: ${JSON.stringify(res.body)}`).toBe(200);
  await pollUntil(
    () => ctx.hubDb.getServerState(ctx.deviceId),
    (s) => s.lifecycleStatus === 'PROVISIONING',
    { timeout: 60_000, interval: 3_000 },
  );
  const record = await pollUntil(
    () => ctx.bridgeRedis.getDeviceRecord(ctx.deviceId),
    (r) => r !== null && r.status === 'PROVISIONING' && Boolean(r.last_job_id),
    { timeout: 120_000, interval: 3_000 },
  );
  expect(record, 'bridge device record never adopted the provision job').not.toBeNull();
  return record!.last_job_id as string;
}

const spokeFailoverStep: Step = {
  id: 'spoke-failover',
  label: 'Spoke failover (kill working spoke)',
  parseParams() {},
  async run(ctx) {
    await requireHaSpokes();
    step('spoke-failover: firing provision...');
    const jobId = await fireProvision(ctx, 'e2e-failover');

    const working = await awaitWorkingSpoke(jobId, { timeout: 180_000, interval: 3_000 });
    expect(working, 'no spoke logged it was working the provision plan within 180s').not.toBeNull();
    expect(await deviceLockHeld(ctx.deviceId), `spoke ${working} is working but holds no device lock`).toBe(true);

    const killed = working!;
    try {
      step(`spoke-failover: killing ${killed}...`);
      await controlSpoke(killed, 'stop');
      expect(await awaitSpokeState(killed, { running: false, timeout: 60_000 }), `${killed} did not stop`).toBe(false);

      step('spoke-failover: awaiting a survivor to finish the failed-over saga...');
      const final = await pollUntil(
        () => ctx.hubDb.getServerState(ctx.deviceId),
        (s) => s.lifecycleStatus === 'PROVISIONED' || s.lifecycleStatus === 'FAILED',
        { timeout: 900_000, interval: 15_000 },
      );
      expect(final.lifecycleStatus, `after killing ${killed}, provision ended ${final.lifecycleStatus}`).toBe(
        'PROVISIONED',
      );
      const survivors = new Set((await runningSpokes()).map((s) => s.id));
      expect(survivors.has(killed), `killed spoke ${killed} is unexpectedly running again`).toBe(false);
      step(`spoke-failover: a survivor completed the saga (killed ${killed})`);
    } finally {
      // Restore the killed spoke so the stack is whole for later steps / runs.
      try {
        await controlSpoke(killed, 'start');
        await awaitSpokeState(killed, { running: true, timeout: 120_000 });
      } catch (err) {
        step(`spoke-failover: could not restore ${killed}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  },
};

const spokeResumeStep: Step = {
  id: 'spoke-resume',
  label: 'Spoke restart-resume (restart working spoke)',
  parseParams() {},
  async run(ctx) {
    await requireHaSpokes();
    step('spoke-resume: firing provision...');
    const jobId = await fireProvision(ctx, 'e2e-resume');

    const working = await awaitWorkingSpoke(jobId, { timeout: 180_000, interval: 3_000 });
    expect(working, 'no spoke logged it was working the provision plan within 180s').not.toBeNull();

    const plan = await pollUntil(
      () => getPlanSnapshot(jobId),
      (p) => p !== null,
      { timeout: 60_000, interval: 3_000 },
    );
    expect(plan, `no persisted lifecycle plan at plan_id ${jobId} -- cannot verify resume`).not.toBeNull();
    // Restart only once the plan has real completed work to preserve. Snapshotting
    // completedBefore the instant the plan exists lets it be 0, making the resume
    // assertion (completedAfter >= completedBefore) vacuously pass at 0 >= 0.
    const completedBefore = await pollUntil(
      () => planCompletedStepCount(jobId),
      (n) => n > 0,
      { timeout: 180_000, interval: 3_000 },
    );
    expect(
      completedBefore,
      `plan ${jobId} completed no steps before restart -- resume assertion would be vacuous`,
    ).toBeGreaterThan(0);

    step(`spoke-resume: restarting ${working} (completed steps before: ${completedBefore})...`);
    // The control center's combined 'restart' action is unreliable for the spoke
    // (stops the process but doesn't reliably re-start it), so use stop+start.
    // Bringing the SAME spoke back is best-effort, not asserted: the saga resumes
    // regardless -- a surviving spoke recovers the stalled job and crash-resumes
    // the persisted plan (proven by spoke-failover). The real assertions below are
    // the resume OUTCOME: the device reaches PROVISIONED without losing completed
    // steps. (Asserting the restarted spoke is back makes the test brittle on the
    // local env's spoke-restart timing, which is orthogonal to resume.)
    await controlSpoke(working!, 'stop');
    await awaitSpokeState(working!, { running: false, timeout: 60_000 });
    await controlSpoke(working!, 'start');
    const back = await awaitSpokeState(working!, { running: true, timeout: 180_000, interval: 3_000 });
    step(
      back
        ? `spoke-resume: ${working} restarted`
        : `spoke-resume: ${working} did not restart in time -- a surviving spoke should resume the saga`,
    );

    step('spoke-resume: awaiting the resumed saga to reach PROVISIONED...');
    const final = await pollUntil(
      () => ctx.hubDb.getServerState(ctx.deviceId),
      (s) => s.lifecycleStatus === 'PROVISIONED' || s.lifecycleStatus === 'FAILED',
      { timeout: 900_000, interval: 15_000 },
    );
    const completedAfter = await planCompletedStepCount(jobId);
    expect(final.lifecycleStatus, `after restarting ${working}, provision ended ${final.lifecycleStatus}`).toBe(
      'PROVISIONED',
    );
    expect(
      completedAfter,
      `resumed plan regressed: ${completedAfter} completed steps after restart vs ${completedBefore} before`,
    ).toBeGreaterThanOrEqual(completedBefore);
    step(`spoke-resume: resumed to PROVISIONED (completed ${completedBefore} -> ${completedAfter})`);
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

register(defineStep(provisionStep('provision', 'e2e-plan')));
register(defineStep(provisionStep('reprovision', 'e2e-plan-reprov')));
register(defineStep(powerCycleStep));
register(defineStep(endRentalStep));
register(defineStep(verifyOsStep));
register(defineStep(verifyLayersStep));
register(defineStep(verifyDiskStep));
register(defineStep(rescueActivateStep));
register(defineStep(rescueDeactivateStep));
register(defineStep(verifyCloudInitStep));
register(defineStep(ipxeCustomStep));
register(defineStep(spokeFailoverStep));
register(defineStep(spokeResumeStep));
