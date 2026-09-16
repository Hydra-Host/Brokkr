import type { DeviceRecord } from '../device-record/device-record.schema';
import type { DiscoveryFlavor } from '../download/discovery.config';

import type { RenderRequest } from './ipxe-renderer.helpers';

export const NIL_DEVICE_ID = '00000000-0000-0000-0000-000000000000';

export const RESCUE_OS_SLUG = 'ubuntu-rescue-os';

export type ResolveOutcomeKind = 'UNKNOWN' | 'KNOWN_RECORD_MISSING';

export type ResolveResult = ResolveOutcomeKind | DeviceRecord;

export type ScriptKind = 'discovery' | 'disk' | 'unknown' | 'retry' | 'custom';

export interface RendererCall {
  method:
    | 'render_discovery'
    | 'render_disk'
    | 'render_unknown'
    | 'render_retry'
    | 'render_custom'
    | 'inventory_trigger';
  kwargs: Record<string, unknown>;
}

export interface RendererSpy {
  render_discovery(args: Record<string, unknown>): Promise<string>;
  render_disk(args: Record<string, unknown>): Promise<string>;
  render_unknown(args: Record<string, unknown>): Promise<string>;
  render_retry(args?: Record<string, unknown>): Promise<string>;
  render_custom(args: Record<string, unknown>): Promise<string>;
}

export interface InventoryTriggerLogger {
  warn(message: string, meta?: Record<string, unknown>): void | Promise<void>;
}

export interface RenderForRecordContext {
  record: ResolveResult;
  request: RenderRequest;
  jobId: string;
  pendingRegistered?: boolean;
  discoveryPlatformSlug?: string;
  discoveryFlavors: readonly DiscoveryFlavor[];
  redisIpxeUrl?: string | null;
  redisIpxeUrlLookup?: (deviceId: string, jobId: string) => Promise<string | null>;
  renderer: RendererSpy;
  triggerInventoryCollection?: (deviceId: string, jobId: string) => Promise<void> | void;
  getKernelNetworkParams?: (record: DeviceRecord, jobId: string) => Promise<string[]> | string[];
  events?: RendererCall[];
  inventoryTriggerLogger?: InventoryTriggerLogger;
}
