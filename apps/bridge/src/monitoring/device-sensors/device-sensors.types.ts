import type { BmcCredentials } from '../../common/bmc.types';
import type { SensorProbe } from '../common/cdu-scrape-plan.service';

export type { Extract, SensorProbe } from '../common/cdu-scrape-plan.service';

export type SensorPoint = Record<string, string | number>;

export type MeasurementPoints = Record<string, SensorPoint[]>;

export enum GpuLayout {
  NONE = 'none',
  DELL_IDRAC9 = 'dell_idrac9',
  LENOVO_XCC = 'lenovo_xcc',
  CISCO_CBMC = 'cisco_cbmc',
  GRAPHICS_CONTROLLER = 'graphics_controller',
  SUPERMICRO_ASPEED = 'supermicro_aspeed',
  NVIDIA_HGX = 'nvidia_hgx',
}

export interface VendorHints {
  readonly baselineChassisId: string;
  readonly baselineUrlTrailingSlash: boolean;
  readonly gpuLayout: GpuLayout;
  readonly gpuCount: number;
  readonly gpuSlots: ReadonlyArray<number>;
  readonly gpuChassisIds: ReadonlyArray<string>;
}

export interface DeviceVendorHints {
  get(deviceId: string, creds: BmcCredentials): Promise<VendorHints>;
}

export interface RedfishProbeClient {
  authRejected: boolean;
  resetAuth(): void;
  get(
    bmcIp: string,
    path: string,
    opts: { username: string; password: string; jobId?: string; signal?: AbortSignal },
  ): Promise<Record<string, unknown> | null>;
}

export interface ScrapePlanDeps {
  buildScrapePlan(hints: VendorHints): SensorProbe[];
  extractPoints(body: Record<string, unknown>, probe: SensorProbe): MeasurementPoints;
  readonly allMeasurements: ReadonlyArray<string>;
}
