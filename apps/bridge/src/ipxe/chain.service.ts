import { Inject, Injectable, Optional } from '@nestjs/common';

import { getApplicationConfig } from '../core/application.config';
import type { DeviceRecord } from '../device-record/device-record.schema';
import { DeviceRecordService, ResolveOutcome, type ResolveResult } from '../device-record/device-record.service';
import { isHardwarePlaceholder, isLocallyAdministeredMac, MAC_KINDS } from '../device-record/identifier-kinds';
import { getDiscoveryFileConfig } from '../download/discovery.config';
import { logWarning } from '../logger/logger.service';

import { renderForRecord } from './chain-decision';
import type { InventoryTriggerLogger, RendererSpy, RenderForRecordContext } from './chain.types';
import { validateRenderRequest, type RenderRequest } from './ipxe-renderer.helpers';
import { getIpxeConfig } from './ipxe.config';

export const IPXE_RENDERER = Symbol('IpxeRenderer');
export const IPXE_REDIS_IPXE_URL_LOOKUP = Symbol('IpxeRedisIpxeUrlLookup');
export const IPXE_KERNEL_NETWORK_BUILDER = Symbol('IpxeKernelNetworkBuilder');
export const IPXE_INVENTORY_TRIGGER = Symbol('IpxeInventoryTrigger');
export const IPXE_INVENTORY_TRIGGER_LOGGER = Symbol('IpxeInventoryTriggerLogger');

export type RedisIpxeUrlLookup = (deviceId: string, jobId: string) => Promise<string | null>;
export type KernelNetworkBuilder = (record: DeviceRecord, jobId: string) => Promise<string[]>;
export type InventoryTrigger = (deviceId: string, jobId: string) => Promise<void>;

export const CHAIN_RESOLVE_TIMEOUT_S = 3;

@Injectable()
export class ChainService {
  constructor(
    private readonly deviceRecord: DeviceRecordService,
    @Inject(IPXE_RENDERER) private readonly renderer: RendererSpy,
    @Optional()
    @Inject(IPXE_REDIS_IPXE_URL_LOOKUP)
    private readonly redisIpxeUrlLookup?: RedisIpxeUrlLookup,
    @Optional()
    @Inject(IPXE_KERNEL_NETWORK_BUILDER)
    private readonly kernelNetworkBuilder?: KernelNetworkBuilder,
    @Optional()
    @Inject(IPXE_INVENTORY_TRIGGER)
    private readonly inventoryTrigger?: InventoryTrigger,
    @Optional()
    @Inject(IPXE_INVENTORY_TRIGGER_LOGGER)
    private readonly inventoryTriggerLogger?: InventoryTriggerLogger,
  ) {}

  async resolveRecord(
    identifiers: Readonly<Record<string, string>>,
    buildarch: string | null | undefined,
    jobId: string,
    renderFacts?: Record<string, string> | null,
  ): Promise<ResolveResult> {
    const stripLaaMacs = !getApplicationConfig().localSimulationEnabled;
    const usable: Record<string, string> = {};
    const droppedLaa: Record<string, string> = {};
    const droppedPlaceholder: Record<string, string> = {};
    for (const [kind, value] of Object.entries(identifiers)) {
      if (stripLaaMacs && MAC_KINDS.has(kind) && isLocallyAdministeredMac(value)) {
        droppedLaa[kind] = value;
      } else if (isHardwarePlaceholder(value)) {
        droppedPlaceholder[kind] = value;
      } else {
        usable[kind] = value;
      }
    }
    if (Object.keys(droppedLaa).length > 0) {
      await logWarning(
        `Ignoring locally-administered MAC(s) for device identity: ${JSON.stringify(droppedLaa)} — using BMC MAC/serials instead`,
        { jobId, appClassName: 'ipxe-chain' },
      );
    }
    if (Object.keys(droppedPlaceholder).length > 0) {
      await logWarning(
        `Ignoring BIOS placeholder identifier(s) for device identity: ${JSON.stringify(droppedPlaceholder)}`,
        {
          jobId,
          appClassName: 'ipxe-chain',
        },
      );
    }
    if (Object.keys(usable).length === 0) {
      return ResolveOutcome.UNKNOWN;
    }
    return this.deviceRecord.resolveDevice(usable, {
      buildarch: buildarch ?? null,
      jobId,
      timeoutS: CHAIN_RESOLVE_TIMEOUT_S,
      renderFacts: renderFacts ?? null,
    });
  }

  async resolveByPointerOnly(identifiers: Readonly<Record<string, string>>, jobId: string): Promise<ResolveResult> {
    const stripLaaMacs = !getApplicationConfig().localSimulationEnabled;
    const usable: Record<string, string> = {};
    for (const [kind, value] of Object.entries(identifiers)) {
      if (stripLaaMacs && MAC_KINDS.has(kind) && isLocallyAdministeredMac(value)) continue;
      usable[kind] = value;
    }
    if (Object.keys(usable).length === 0) return ResolveOutcome.UNKNOWN;
    return this.deviceRecord.resolveByPointerOnly(usable, jobId);
  }

  async renderForRecord(
    record: ResolveResult,
    request: RenderRequest,
    jobId: string,
    pendingRegistered = false,
  ): Promise<string> {
    const config = getIpxeConfig();
    const ctx: RenderForRecordContext = {
      record,
      request,
      jobId,
      pendingRegistered,
      discoveryPlatformSlug: config.discoveryPlatformSlug,
      discoveryFlavors: getDiscoveryFileConfig().flavors,
      renderer: this.renderer,
      ...(this.redisIpxeUrlLookup ? { redisIpxeUrlLookup: this.redisIpxeUrlLookup } : {}),
      ...(this.inventoryTrigger ? { triggerInventoryCollection: this.inventoryTrigger } : {}),
      ...(this.kernelNetworkBuilder ? { getKernelNetworkParams: this.kernelNetworkBuilder } : {}),
      ...(this.inventoryTriggerLogger ? { inventoryTriggerLogger: this.inventoryTriggerLogger } : {}),
    };
    return renderForRecord(ctx);
  }

  validateRequest(request: RenderRequest): void {
    validateRenderRequest(request);
  }
}
