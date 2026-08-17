import { isRecord } from '@repo/utils';

import type { BmcCredentials } from '../../common/bmc.types';
import { logWarning } from '../../core/logging/bridge-logger';

import type { VendorHints } from './device-vendor-hints';
import { GpuLayout, defaultVendorHints } from './device-vendor-hints';

export { GpuLayout, defaultVendorHints } from './device-vendor-hints';
export type { VendorHints } from './device-vendor-hints';

const APP_CLASS_NAME = 'redfish-vendor-hints';

const KNOWN_BASELINE_CHASSIS_IDS: readonly string[] = ['1', 'System.Embedded.1', 'Self', 'chassis'];

const CISCO_GPU_CHASSIS_RE = /^GPU_(\d+)$/;
const HGX_GPU_PLAIN_RE = /^HGX_GPU_\d+$/;
const HGX_GPU_SXM_RE = /^HGX_GPU_SXM_\d+$/;

const LENOVO_GPU_RE = /\/Processors\/GPU\d+\/?$/;
const SUPERMICRO_GPU_RE = /\/PCIeDevices\/GPU\d+\/?$/;

export interface RedfishProbeClient {
  authRejected: boolean;
  resetAuth(): void;
  get(
    bmcIp: string,
    path: string,
    options: { username: string; password: string; jobId?: string },
  ): Promise<Record<string, unknown> | null>;
}

export function memberCount(body: Record<string, unknown>): number {
  const count = body['Members@odata.count'];
  if (typeof count === 'number' && Number.isInteger(count)) {
    return count;
  }
  const members = body['Members'];
  return Array.isArray(members) ? members.length : 0;
}

export function identifyVendor(root: Record<string, unknown>): {
  vendor: string;
  variant: string | null;
} {
  const rawVendor = root['Vendor'];
  const raw = (typeof rawVendor === 'string' ? rawVendor : '').trim();
  const redfishVersion = typeof root['RedfishVersion'] === 'string' ? (root['RedfishVersion'] as string) : null;

  if (raw) {
    if (raw.toLowerCase().startsWith('cisco')) {
      return { vendor: 'cisco', variant: null };
    }
    return { vendor: raw.toLowerCase(), variant: redfishVersion };
  }

  const oemRaw = root['Oem'];
  const oem = isRecord(oemRaw) ? oemRaw : {};
  const oemKeys = Object.keys(oem);
  if (oemKeys.includes('Hp')) {
    return { vendor: 'hp', variant: redfishVersion };
  }
  if (oemKeys.includes('Public')) {
    const publicNode = oem['Public'];
    const publicObj = isRecord(publicNode) ? publicNode : {};
    const mfrRaw = publicObj['Manufacturer'];
    const mfr = typeof mfrRaw === 'string' ? mfrRaw : '';
    if (mfr.trim().toUpperCase() === 'AIVRES') {
      return { vendor: 'aivres', variant: redfishVersion };
    }
  }
  return { vendor: '', variant: redfishVersion };
}

export function extractChassisMemberIds(chassisCollection: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const members = chassisCollection['Members'];
  if (!Array.isArray(members)) {
    return ids;
  }
  for (const m of members) {
    if (!isRecord(m)) continue;
    const odataRaw = m['@odata.id'];
    const odataId = (typeof odataRaw === 'string' ? odataRaw : '').replace(/\/+$/, '');
    if (odataId) {
      const lastSlash = odataId.lastIndexOf('/');
      ids.push(lastSlash === -1 ? odataId : odataId.slice(lastSlash + 1));
    }
  }
  return ids;
}

export function pickHgxChassisIds(memberIds: readonly string[]): string[] {
  const plain = memberIds.filter((c) => HGX_GPU_PLAIN_RE.test(c)).sort();
  if (plain.length > 0) {
    return plain;
  }
  return memberIds.filter((c) => HGX_GPU_SXM_RE.test(c)).sort();
}

export function pickBaselineChassisId(memberIds: readonly string[]): string {
  for (const known of KNOWN_BASELINE_CHASSIS_IDS) {
    if (memberIds.includes(known)) {
      return known;
    }
  }
  return '1';
}

export class RedfishDeviceVendorHints {
  constructor(private readonly probe: RedfishProbeClient) {}

  async get(deviceId: string, creds: BmcCredentials): Promise<VendorHints> {
    return this.discover({
      bmcIp: creds.bmcIp,
      username: creds.username,
      password: creds.password,
      deviceId: String(deviceId),
    });
  }

  private async discover(args: {
    bmcIp: string;
    username: string;
    password: string;
    deviceId: string;
  }): Promise<VendorHints> {
    const { bmcIp, username, password, deviceId } = args;

    const root = await this.probe.get(bmcIp, '/redfish/v1/', { username, password, jobId: deviceId });
    if (root === null) {
      logWarning(`vendor-hints: /redfish/v1/ unreachable for ${bmcIp}`, {
        appClassName: APP_CLASS_NAME,
        jobId: deviceId,
      });
      return defaultVendorHints();
    }

    const { vendor } = identifyVendor(root);

    const chassis = await this.probe.get(bmcIp, '/redfish/v1/Chassis', { username, password, jobId: deviceId });
    const chassisMemberIds = extractChassisMemberIds(chassis ?? {});

    const baselineChassisId = pickBaselineChassisId(chassisMemberIds);
    const hgxChassisIds = pickHgxChassisIds(chassisMemberIds);
    const ciscoGpuCount = chassisMemberIds.reduce((acc, c) => acc + (CISCO_GPU_CHASSIS_RE.test(c) ? 1 : 0), 0);

    let gpuLayout: GpuLayout = GpuLayout.NONE;
    let gpuCount = 0;
    let gpuSlots: readonly number[] = [];
    let gpuChassisIds: readonly string[] = [];
    let baselineUrlTrailingSlash = false;

    if (hgxChassisIds.length > 0) {
      gpuLayout = GpuLayout.NVIDIA_HGX;
      gpuChassisIds = hgxChassisIds;
    } else if (ciscoGpuCount) {
      gpuLayout = GpuLayout.CISCO_CBMC;
      gpuCount = ciscoGpuCount;
    } else if (vendor === 'dell') {
      const n = await this.probeDellGpuCount(bmcIp, username, password, deviceId);
      if (n) {
        gpuLayout = GpuLayout.DELL_IDRAC9;
        gpuCount = n;
      }
    } else if (vendor === 'lenovo') {
      const n = await this.probeLenovoGpuCount(bmcIp, username, password, deviceId);
      if (n) {
        gpuLayout = GpuLayout.LENOVO_XCC;
        gpuCount = n;
      }
    } else if (vendor === 'supermicro') {
      const slots = await this.probeSupermicroSlots(bmcIp, username, password, deviceId);
      if (slots.length > 0) {
        gpuLayout = GpuLayout.SUPERMICRO_ASPEED;
        gpuSlots = slots;
      }
    } else if (vendor === 'aivres') {
      const n = await this.probeGraphicsControllerGpus(bmcIp, username, password, deviceId);
      if (n) {
        gpuLayout = GpuLayout.GRAPHICS_CONTROLLER;
        gpuCount = n;
      }
    } else if (vendor === 'hp') {
      baselineUrlTrailingSlash = true;
    }

    if (gpuLayout === GpuLayout.NONE && vendor === '') {
      const n = await this.probeGraphicsControllerGpus(bmcIp, username, password, deviceId);
      if (n) {
        gpuLayout = GpuLayout.GRAPHICS_CONTROLLER;
        gpuCount = n;
      }
    }

    return {
      baselineChassisId,
      baselineUrlTrailingSlash,
      gpuLayout,
      gpuCount,
      gpuSlots,
      gpuChassisIds,
    };
  }

  private async probeDellGpuCount(
    bmcIp: string,
    username: string,
    password: string,
    deviceId: string,
  ): Promise<number> {
    const body = await this.probe.get(bmcIp, '/redfish/v1/Systems/System.Embedded.1/Oem/Dell/DellGPUSensors', {
      username,
      password,
      jobId: deviceId,
    });
    if (!body) return 0;
    return memberCount(body);
  }

  private async probeLenovoGpuCount(
    bmcIp: string,
    username: string,
    password: string,
    deviceId: string,
  ): Promise<number> {
    const body = await this.probe.get(bmcIp, '/redfish/v1/Systems/1/Processors', {
      username,
      password,
      jobId: deviceId,
    });
    if (!body) return 0;
    const members = body['Members'];
    if (!Array.isArray(members)) return 0;
    let n = 0;
    for (const m of members) {
      if (!isRecord(m)) continue;
      const odata = '@odata.id' in m ? m['@odata.id'] : undefined;
      if (odata === undefined || odata === null || odata === '' || odata === 0 || odata === false) {
        continue;
      }
      if (Array.isArray(odata) && odata.length === 0) continue;
      if (isRecord(odata) && Object.keys(odata).length === 0) continue;
      if (typeof odata !== 'string') {
        throw new TypeError(`Expected string for @odata.id, got ${typeof odata}`);
      }
      if (LENOVO_GPU_RE.test(odata)) {
        n += 1;
      }
    }
    return n;
  }

  private async probeSupermicroSlots(
    bmcIp: string,
    username: string,
    password: string,
    deviceId: string,
  ): Promise<number[]> {
    const coll = await this.probe.get(bmcIp, '/redfish/v1/Chassis/1/PCIeDevices', {
      username,
      password,
      jobId: deviceId,
    });
    if (!coll) return [];
    const members = coll['Members'];
    if (!Array.isArray(members)) return [];
    const gpuPaths: string[] = [];
    for (const m of members) {
      if (!isRecord(m)) continue;
      const odata = '@odata.id' in m ? m['@odata.id'] : undefined;
      if (odata === undefined || odata === null || odata === '' || odata === 0 || odata === false) {
        continue;
      }
      if (Array.isArray(odata) && odata.length === 0) continue;
      if (isRecord(odata) && Object.keys(odata).length === 0) continue;
      if (typeof odata !== 'string') {
        throw new TypeError(`Expected string for @odata.id, got ${typeof odata}`);
      }
      if (SUPERMICRO_GPU_RE.test(odata)) {
        gpuPaths.push(odata);
      }
    }
    const slots: number[] = [];
    for (const path of gpuPaths) {
      const dev = await this.probe.get(bmcIp, path, { username, password, jobId: deviceId });
      if (!dev) continue;
      const oemRaw: unknown = 'Oem' in dev ? dev['Oem'] : {};
      if (!isRecord(oemRaw)) {
        throw new TypeError(
          `Cannot read property 'Supermicro' of non-object Oem (got ${oemRaw === null ? 'null' : typeof oemRaw})`,
        );
      }
      const supermicroRaw: unknown = 'Supermicro' in oemRaw ? oemRaw['Supermicro'] : {};
      let supermicroObj: Record<string, unknown>;
      if (
        supermicroRaw === null ||
        supermicroRaw === undefined ||
        supermicroRaw === 0 ||
        supermicroRaw === '' ||
        supermicroRaw === false
      ) {
        supermicroObj = {};
      } else if (Array.isArray(supermicroRaw) && supermicroRaw.length === 0) {
        supermicroObj = {};
      } else if (isRecord(supermicroRaw) && Object.keys(supermicroRaw).length === 0) {
        supermicroObj = {};
      } else if (isRecord(supermicroRaw)) {
        supermicroObj = supermicroRaw;
      } else {
        throw new TypeError(`Cannot read property 'GPUSlot' of non-object Supermicro (got ${typeof supermicroRaw})`);
      }
      const slot = supermicroObj['GPUSlot'];
      if (typeof slot === 'number' && Number.isInteger(slot)) {
        slots.push(slot);
      }
    }
    return slots.sort((a, b) => a - b);
  }

  private async probeGraphicsControllerGpus(
    bmcIp: string,
    username: string,
    password: string,
    deviceId: string,
  ): Promise<number> {
    const coll = await this.probe.get(bmcIp, '/redfish/v1/Systems/1/GraphicsControllers', {
      username,
      password,
      jobId: deviceId,
    });
    if (!coll) return 0;
    return memberCount(coll);
  }
}

export class RecordedProbeClient implements RedfishProbeClient {
  authRejected = false;
  readonly calls: string[] = [];
  private readonly recordings: Record<string, Record<string, unknown>>;
  private readonly rejectPassword: string | null;

  constructor(
    recordings: Record<string, Record<string, unknown>>,
    options: { rejectAuthForPassword?: string | null } = {},
  ) {
    this.recordings = { ...recordings };
    this.rejectPassword = options.rejectAuthForPassword ?? null;
  }

  resetAuth(): void {
    this.authRejected = false;
  }

  async get(
    _bmcIp: string,
    path: string,
    options: { username?: string; password?: string; jobId?: string },
  ): Promise<Record<string, unknown> | null> {
    this.calls.push(path);
    if (this.rejectPassword !== null && options.password === this.rejectPassword) {
      this.authRejected = true;
      return null;
    }
    const body = this.recordings[path];
    // Empty recordings must surface as null so the root-probe early-return fires ({} is truthy).
    if (body === undefined) return null;
    if (Object.keys(body).length === 0) return null;
    return body;
  }
}
