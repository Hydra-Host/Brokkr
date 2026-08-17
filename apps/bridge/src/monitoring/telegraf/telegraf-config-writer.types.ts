import type { BmcCredentials } from '../../common/bmc.types';

export interface BridgePartitionerPort {
  owns(deviceId: string): boolean;
}

export interface BmcCredentialsLookupPort {
  get(deviceId: string): Promise<BmcCredentials | null>;
}

export interface ActiveDevicesPort {
  iterActiveDeviceIds(jobId: string): AsyncIterable<string>;
  getCachedDeviceData(deviceId: string, jobId: string): Promise<Record<string, unknown> | null>;
}

export interface InfraTargetsPort {
  extractRole(deviceData: Record<string, unknown> | null): string | null;
  classifyRole(role: string | null): string;
}

export interface PduVendorClassifierPort {
  classifyPduVendor(deviceData: Record<string, unknown> | null): string | null;
}

export interface TelegrafConfigWriterLogger {
  info(message: string, context?: { jobId?: string; appClassName?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string; appClassName?: string }): Promise<void>;
}
