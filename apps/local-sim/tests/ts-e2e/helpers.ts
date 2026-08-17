/**
 * Shared helper functions for TypeScript e2e tests.
 *
 * Ports of the Python helpers in `tests/e2e/helpers.py` + the derived-value
 * functions from `scripts/local/derived.py` that the helpers depend on.
 */

import { isIpxeCustomOs } from '@repo/api-client/schemas/common';
import { load as yamlLoad } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export { isIpxeCustomOs };

// ---------------------------------------------------------------------------
// Fleet config schemas — the rendered fleet.yml guarantees only name/ipmi_mac/data_mac
// per node; the rest is host-detected, defaulted, or index-derived on the Python side.
// ---------------------------------------------------------------------------

const FleetNodeSchema = z.object({
  name: z.string(),
  ipmi_mac: z.string(),
  data_mac: z.string(),
  cpus: z.number().optional(),
  memory_mb: z.number().optional(),
  disk_gb: z.number().optional(),
  arch: z.string().optional(),
  ip: z.string().nullable().default(null),
  bmc_ip: z.string().nullable().default(null),
  zone: z.string().optional(),
});

const FleetNetworkSchema = z.object({
  name: z.string(),
  cidr: z.string(),
  domain: z.string(),
  bmc_cidr: z.string(),
});

// Mirrors scripts/local/schema.py BareMetalNode/BareMetal — the bare-metal roster the rendered
// fleet.yaml carries INSTEAD of `nodes` (which is deliberately empty in baremetal mode).
const BareMetalNodeSchema = z.object({
  name: z.string(),
  pxe_mac: z.string(),
  bmc_ip: z.string(),
  bmc_mac: z.string(),
  arch: z.string().optional(),
  zone: z.string().optional(),
  system_id: z.string().nullable().default(null),
});

const BareMetalSchema = z.object({
  iface: z.string(),
  iface_ip: z.string(),
  arch: z.string().default('amd64'),
  nodes: z.array(BareMetalNodeSchema),
});

const FleetSchema = z.object({
  mode: z.enum(['vm', 'baremetal']).default('vm'),
  network: FleetNetworkSchema,
  nodes: z.array(FleetNodeSchema),
  baremetal: BareMetalSchema.nullable().default(null),
});

export type FleetNode = z.infer<typeof FleetNodeSchema>;
export type FleetNetwork = z.infer<typeof FleetNetworkSchema>;
export type BareMetalNode = z.infer<typeof BareMetalNodeSchema>;
export type BareMetal = z.infer<typeof BareMetalSchema>;
export type Fleet = z.infer<typeof FleetSchema>;

export function loadFleet(): Fleet {
  const fleetPath = process.env.LOCAL_FLEET_PATH;
  if (!fleetPath) {
    throw new Error('LOCAL_FLEET_PATH env var is required');
  }
  const raw = readFileSync(fleetPath, 'utf8');
  return FleetSchema.parse(yamlLoad(raw));
}

// ---------------------------------------------------------------------------
// HubDb — thin async wrapper over Prisma for the two reads the helpers need
// ---------------------------------------------------------------------------

/**
 * Hub database access for test helpers. Callers provide an implementation
 * backed by Prisma (or raw SQL) that satisfies these two methods.
 */
export interface HubDb {
  /** Read `Server.storageLayouts` for a device (joined via `Server.deviceId`). */
  getStorageLayouts(deviceId: string): Promise<StorageLayouts | null>;

  /**
   * Return IDs of all non-certificate SSH keys, ordered by name.
   * Excludes Vault-signed cert pubkeys (`*-cert-v01@openssh.com`) that would
   * silently fail auth against the deployed sshd.
   */
  listSshKeyIds(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Storage-layout types (the shapes living in Server.storageLayouts JSON)
// ---------------------------------------------------------------------------

export interface StorageDiskEntry {
  name: string;
  [key: string]: unknown;
}

export interface StorageConfig {
  disk_group_name?: string;
  disk_type?: string;
  disks?: StorageDiskEntry[];
  [key: string]: unknown;
}

export interface StorageDiskGroup {
  group?: string;
  config?: string;
  file_system?: string;
  mountpoint?: string;
  [key: string]: unknown;
}

export interface StorageDefaults {
  os_disks_group?: StorageDiskGroup;
  data_disks_groups?: StorageDiskGroup[];
}

export interface StorageLayouts {
  configs?: StorageConfig[];
  default?: StorageDefaults;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Disk-layout selection (the disk-layout picker's output shape)
// ---------------------------------------------------------------------------

export interface DiskLayoutSelection {
  os?: StorageDiskGroup;
  data?: StorageDiskGroup[];
}

// ---------------------------------------------------------------------------
// Provision payload shape (what the admin UI submits)
// ---------------------------------------------------------------------------

export interface ProvisionPayload {
  deploymentName: string;
  operatingSystem: string;
  password: string;
  sshKeyIds: string[];
  diskLayouts: DiskLayoutEntry[];
  cloudInit?: string | Record<string, unknown>;
  customizations?: Record<string, string | string[]>;
  ipxeUrl?: string;
}

export interface DiskLayoutEntry {
  config: string;
  format: string;
  mountpoint: string;
  diskType: string;
  disks: string[];
  wipe: boolean;
}

// ---------------------------------------------------------------------------
// Derived values (ported from scripts/local/derived.py)
// ---------------------------------------------------------------------------

/**
 * Parse a CIDR string and return the network address as a 32-bit integer.
 * Handles host bits in the address (non-strict, same as Python's `strict=False`).
 */
function networkAddressInt(cidr: string): number {
  const [addrStr = '0.0.0.0', prefixStr = '0'] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const parts = addrStr.split('.').map((p) => parseInt(p, 10));
  const addr = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (addr & mask) >>> 0;
}

/** Convert a 32-bit integer to a dotted-decimal IPv4 string. */
function intToIp(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

function ipAtOffset(cidr: string, offset: number): string {
  return intToIp(networkAddressInt(cidr) + offset);
}

/**
 * Data-plane IP for the N-th node, offset by 10 (gpu-1 -> .10, gpu-2 -> .11).
 *
 * Baked into the iPXE embed script as the static IP so bridge connectivity
 * is deterministic regardless of DHCP races.
 */
export function nodeIp(cidr: string, index: number): string {
  return ipAtOffset(cidr, 10 + index);
}

/**
 * Node's data-plane IP: the explicit `fleet.yml` override (`node.ip`) if set,
 * else the deterministic index-derived `nodeIp`.
 *
 * The single accessor every consumer must use so they all agree on one IP
 * per node.
 */
export function effectiveNodeIp(node: FleetNode, cidr: string, index: number): string {
  return node.ip ?? nodeIp(cidr, index);
}

/**
 * BMC IP for the N-th node on the OOB plane (host loopback alias).
 *
 * Same offset rule as `nodeIp`. ipmi_sim binds each on loopback so bridge
 * targets distinct BMC IPs; traffic never leaves the host.
 */
export function bmcIp(cidr: string, index: number): string {
  return ipAtOffset(cidr, 10 + index);
}

/**
 * Node's BMC-plane IP: an explicit `fleet.yml` override (`node.bmc_ip`)
 * if set, else the index-derived `bmcIp`.
 */
export function effectiveBmcIp(node: FleetNode, bmcCidr: string, index: number): string {
  return node.bmc_ip ?? bmcIp(bmcCidr, index);
}

/**
 * SCSI serial for the sim node's OS disk. Stable per MAC.
 *
 * Must match what qemu reports via SCSI INQUIRY (`<serial>` in the libvirt
 * disk element); bridge correlates `lsblk` against
 * `storage_layouts.configs[].disks` by serial.
 */
export function nodeSerial(mac: string): string {
  return `SIM${mac.replace(/:/g, '').toUpperCase()}`;
}

/**
 * Predictable Hub `Device.id` for the sim node at `index` (0-based).
 *
 * Returns `00000000-0000-0000-0000-00000000000N` where N = index+1.
 * Deterministic so re-seeds keep iPXE-baked UUIDs and Hub Device rows aligned.
 */
export function simDeviceUuid(index: number): string {
  return `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// pollUntil
// ---------------------------------------------------------------------------

export interface PollOptions {
  /** Maximum time to wait in milliseconds. Default 300_000 (5 minutes). */
  timeout?: number;
  /** Interval between polls in milliseconds. Default 5_000 (5 seconds). */
  interval?: number;
}

/**
 * Call `fn()` until `predicate(result)` is truthy or `timeout` elapses.
 *
 * Returns the last result either way -- the caller asserts on it so a timeout
 * surfaces as a normal assertion failure showing the actual final value.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  opts?: PollOptions,
): Promise<T> {
  const timeout = opts?.timeout ?? 300_000;
  const interval = opts?.interval ?? 5_000;
  const deadline = Date.now() + timeout;

  let result = await fn();
  while (!predicate(result)) {
    if (Date.now() >= deadline) {
      return result;
    }
    await sleep(interval);
    result = await fn();
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fleet-derived lookups
// ---------------------------------------------------------------------------

/** Compute data-plane IP from fleet config for a given node. */
export function nodeIpFromFleet(node: FleetNode, fleet: Fleet): string {
  const index = fleet.nodes.indexOf(node);
  if (index === -1) {
    throw new Error(`node ${node.name} not found in fleet`);
  }
  return effectiveNodeIp(node, fleet.network.cidr, index);
}

/** Compute deterministic device UUID from a node's fleet index. */
export function deviceIdFor(node: FleetNode, fleet: Fleet): string {
  const index = fleet.nodes.indexOf(node);
  if (index === -1) {
    throw new Error(`node ${node.name} not found in fleet`);
  }
  return simDeviceUuid(index);
}

/** Reverse lookup: device UUID -> data-plane IP. */
export function dataIpForDevice(fleet: Fleet, deviceId: string): string {
  for (let i = 0; i < fleet.nodes.length; i++) {
    if (simDeviceUuid(i) === deviceId) {
      return effectiveNodeIp(fleet.nodes[i]!, fleet.network.cidr, i);
    }
  }
  throw new Error(`no fleet node maps to device ${deviceId}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Colon form ONLY: getDataIpByBootMac matches lower(macAddress) against the
// colon-form MAC. A dash-form MAC would pass a liberal guard, then never match
// the seeded interface -> a 7-min opaque poll hang. Reject it up front.
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function explicitDeviceIdFromEnv(): string | null {
  const raw = (process.env.SIM_LC_DEVICE_ID ?? '').trim();
  if (!raw) return null;
  if (!UUID_RE.test(raw)) {
    throw new Error(`SIM_LC_DEVICE_ID=${JSON.stringify(raw)} is not a UUID`);
  }
  return raw;
}

export function bootMacFromEnv(): string | null {
  const raw = (process.env.SIM_LC_BOOT_MAC ?? '').trim();
  if (!raw) return null;
  if (!MAC_RE.test(raw)) {
    throw new Error(`SIM_LC_BOOT_MAC=${JSON.stringify(raw)} is not a colon-form MAC (aa:bb:cc:dd:ee:ff)`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Disk layout builder
// ---------------------------------------------------------------------------

/**
 * Return the `storageLayouts.configs[]` entry whose `disk_group_name`
 * matches `groupName`, falling back to the first config (or `{}`).
 */
function configForGroup(layouts: StorageLayouts, groupName: string | undefined): StorageConfig {
  const configs = layouts.configs ?? [];
  if (groupName != null) {
    const match = configs.find((cfg) => cfg.disk_group_name === groupName);
    if (match) return match;
  }
  return configs[0] ?? {};
}

/**
 * Map one storageLayouts disk group -> one provision `diskLayouts[]` entry.
 *
 * `group` is a `default.os_disks_group` / `data_disks_groups[]` shape.
 * The disk names + diskType are pulled from the matching `configs[]` entry.
 * RAID/LVM `config` is passed through verbatim.
 */
function diskLayoutEntry(layouts: StorageLayouts, group: StorageDiskGroup): DiskLayoutEntry {
  const cfg = configForGroup(layouts, group.group);
  const disks = (cfg.disks ?? []).map((d) => d.name);
  return {
    config: group.config ?? 'lvm',
    format: group.file_system ?? 'ext4',
    mountpoint: group.mountpoint ?? '/',
    diskType: cfg.disk_type ?? 'ssd',
    disks: disks.length > 0 ? disks : ['sda'],
    wipe: true,
  };
}

/**
 * Build the provision `diskLayouts` array from `Server.storageLayouts`.
 *
 * Each returned entry is one concrete disk group ->
 * `{config, format, mountpoint, diskType, disks}`. The OS group always maps
 * to `/`; data groups map to their own mountpoints (`/data0`, ...).
 *
 * `selection` (the disk-layout picker's output) overrides the seeded default.
 * `undefined` falls back to `storageLayouts.default`.
 */
export function buildDiskLayouts(layouts: StorageLayouts, selection?: DiskLayoutSelection): DiskLayoutEntry[] {
  const defaults = layouts.default ?? {};
  const sel = selection ?? {};

  const osGroup: StorageDiskGroup = sel.os ?? defaults.os_disks_group ?? {};
  const dataGroups: StorageDiskGroup[] = sel.data !== undefined ? sel.data : (defaults.data_disks_groups ?? []);

  const entries: DiskLayoutEntry[] = [];
  const usedDisks = new Set<string>();

  if (Object.keys(osGroup).length > 0) {
    const osEntry = { ...osGroup };
    if (osEntry.mountpoint == null) osEntry.mountpoint = '/';
    const e = diskLayoutEntry(layouts, osEntry);
    entries.push(e);
    for (const d of e.disks) usedDisks.add(d);
  }

  for (let i = 0; i < dataGroups.length; i++) {
    const dg = { ...dataGroups[i] };
    if (dg.mountpoint == null) dg.mountpoint = `/data${i}`;
    const e = diskLayoutEntry(layouts, dg);

    // Skip a data group that shares a physical disk with the OS group (e.g. the
    // seeded default data group SSD_53GB collides with an OS-group override on
    // the same sda): two layouts on one disk make curtin fail vgcreate.
    if (e.disks.some((d) => usedDisks.has(d))) {
      continue;
    }
    entries.push(e);
    for (const d of e.disks) usedDisks.add(d);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Provision payload builder
// ---------------------------------------------------------------------------

export interface BuildProvisionPayloadOpts {
  osSlug: string;
  deploymentName: string;
  customizations?: Record<string, string | string[]>;
  cloudInit?: string | Record<string, unknown>;
  ipxeUrl?: string;
  diskLayout?: DiskLayoutSelection;
}

/**
 * Build a valid admin provision request from the device's seeded state.
 *
 * Mirrors what the admin UI submits: the disk layout is derived from
 * `Server.storageLayouts` and the SSH key from the seeded `SshKeys` rows.
 * Throws if either is missing.
 */
export async function buildProvisionPayload(
  hubDb: HubDb,
  deviceId: string,
  opts: BuildProvisionPayloadOpts,
): Promise<ProvisionPayload> {
  const layouts = await hubDb.getStorageLayouts(deviceId);
  if (!layouts || !(layouts.configs ?? []).length) {
    throw new Error(`device ${deviceId} has no seeded storageLayouts`);
  }

  const diskLayouts = buildDiskLayouts(layouts, opts.diskLayout);
  if (!diskLayouts.length) {
    throw new Error(
      `device ${deviceId} storageLayouts produced no diskLayouts (selection=${JSON.stringify(opts.diskLayout)})`,
    );
  }

  const allSshKeyIds = await hubDb.listSshKeyIds();
  if (!allSshKeyIds.length) {
    throw new Error('no seeded SshKeys -- set SIM_OWNER_EMAILS + a ~/.ssh/*.pub and re-seed');
  }

  const limitEnv = (process.env.SIM_SSH_KEY_LIMIT ?? '').trim();
  const parsed = limitEnv ? parseInt(limitEnv, 10) : 0;
  const limit = isNaN(parsed) ? 0 : parsed;
  const sshKeyIds = limit > 0 ? allSshKeyIds.slice(0, limit) : allSshKeyIds;

  const payload: ProvisionPayload = {
    deploymentName: opts.deploymentName,
    operatingSystem: opts.osSlug,
    password: 'brokkr',
    sshKeyIds,
    diskLayouts,
    customizations: opts.customizations ?? {},
  };

  if (opts.cloudInit !== undefined) {
    payload.cloudInit = opts.cloudInit;
  }
  if (opts.ipxeUrl !== undefined) {
    payload.ipxeUrl = opts.ipxeUrl;
  }

  return payload;
}
