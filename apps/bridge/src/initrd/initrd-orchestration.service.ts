import { access } from 'node:fs/promises';
import { basename } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { AgentTokenService } from '../auth/agent-token.service.js';
import { BridgeIpResolutionService } from '../bridge-network/bridge-ip-resolution.service.js';
import {
  getAllBridgeHostnames,
  getBridgeHostsEntriesForClient,
  getBridgeRegistrySnapshot,
} from '../bridge-network/bridge-registry-reader.js';
import { fetchLiveNetplanForInitrd } from '../bridge-network/initrd-netplan.js';
import { NetplanAtomService } from '../bridge-network/netplan-atom.service.js';
import { RedisService } from '../common/redis/redis.service.js';
import type { EnqueueRenderRequest } from '../device-record/atom/atom-fetcher.js';
import { getAtom, readAtom } from '../device-record/atom/atom-fetcher.js';
import { serverTokenAtomSchema } from '../device-record/atom/server-token.schema.js';
import type { DeviceRecord } from '../device-record/device-record.schema.js';
import {
  DEVICE_RECORD_RENDER_ENQUEUER,
  DeviceRecordService,
  isResolveOutcome,
} from '../device-record/device-record.service.js';
import type { AtomFetcherLike, GetAtomParams } from '../devices/device.service.js';
import { createDeviceService } from '../devices/device.service.js';
import { getLeaderConfig } from '../leader-election/leader-election.config.js';

import { createBrokkrDiscoveryInitrdService } from './brokkr-discovery-initrd.service.js';
import { createInitrdServingService } from './initrd-serving.service.js';
import type { ServerTokenAtomFetcher } from './phone-home.service.js';
import { createUbuntuRescueOsInitrdService } from './ubuntu-rescue-os-initrd.service.js';

export interface InitrdServingLike {
  findInitrdFile(buildName?: string | null): Promise<string | null>;
  buildDeviceInitrdOnDemand(buildName: string, clientIp?: string): Promise<void>;
  scheduleDelayedCleanup(path: string, delay?: number): NodeJS.Timeout;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export const STANDARD_INITRD_TYPES = ['brokkr-live.img', 'bridge-agent.img'];

export interface ResolvedInitrdDownload {
  initrdFile: string | null;
  scheduleCleanup: boolean;
  // per-device builds embed live secrets (agent token, phone-home creds, SSH keys) and must be served uncacheable
  secretBearing: boolean;
}

export interface ResolvedInitrdByPath extends ResolvedInitrdDownload {
  invalidBuildName: boolean;
}

@Injectable()
export class InitrdOrchestrationService {
  constructor(
    private readonly redis: RedisService,
    private readonly deviceRecord: DeviceRecordService,
    private readonly netplanAtom: NetplanAtomService,
    private readonly bridgeIpResolver: BridgeIpResolutionService,
    private readonly agentTokens: AgentTokenService,
    @Inject(DEVICE_RECORD_RENDER_ENQUEUER)
    private readonly renderEnqueuer: EnqueueRenderRequest,
  ) {}

  async resolveDefaultDownload(jobId: string, buildName: string | null): Promise<ResolvedInitrdDownload> {
    const service = await this.createServingService(jobId);
    const file = await service.findInitrdFile(buildName);
    const exists = file !== null && (await pathExists(file));
    return { initrdFile: exists ? file : null, scheduleCleanup: false, secretBearing: false };
  }

  async resolveDownloadByPath(jobId: string, buildName: string, clientIp: string): Promise<ResolvedInitrdByPath> {
    if (basename(buildName) !== buildName) {
      return { initrdFile: null, scheduleCleanup: false, secretBearing: false, invalidBuildName: true };
    }
    const isInventoryInitrd = buildName.startsWith('brokkr-discovery-') && buildName.endsWith('.img');
    const isRescueInitrd = buildName.startsWith('ubuntu-rescue-os-') && buildName.endsWith('.img');
    if (!(STANDARD_INITRD_TYPES.includes(buildName) || isInventoryInitrd || isRescueInitrd)) {
      return { initrdFile: null, scheduleCleanup: false, secretBearing: false, invalidBuildName: true };
    }

    const service = await this.createServingService(jobId);
    if (isInventoryInitrd || isRescueInitrd) {
      await service.buildDeviceInitrdOnDemand(buildName, clientIp);
    }

    const file = await service.findInitrdFile(buildName);
    if (file !== null && (isInventoryInitrd || isRescueInitrd)) {
      service.scheduleDelayedCleanup(file);
    }
    const perDevice = isInventoryInitrd || isRescueInitrd;
    return { initrdFile: file, scheduleCleanup: perDevice, secretBearing: perDevice, invalidBuildName: false };
  }

  private serverTokenAtomFetcher(): ServerTokenAtomFetcher {
    return (params) =>
      getAtom({
        cache: this.redis,
        enqueueRenderRequest: this.renderEnqueuer,
        bridgeId: getLeaderConfig().instanceId,
        domain: params.domain,
        entityId: params.entityId,
        atomKey: params.atomKey,
        valueSchema: serverTokenAtomSchema,
        jobId: params.jobId,
      });
  }

  private atomFetcher(): AtomFetcherLike {
    return {
      getAtom: <T>(params: GetAtomParams<T>) =>
        getAtom({
          cache: this.redis,
          enqueueRenderRequest: this.renderEnqueuer,
          bridgeId: getLeaderConfig().instanceId,
          domain: params.domain,
          entityId: params.entityId,
          atomKey: params.atomKey,
          valueSchema: params.valueSchema,
          jobId: params.jobId,
        }),
      readAtom: (key, valueSchema, jobId) => readAtom(this.redis, key, valueSchema, { jobId }),
    };
  }

  async createServingService(jobId: string): Promise<InitrdServingLike> {
    return createInitrdServingService(jobId, {
      cache: this.redis,
      resolveDeviceRecordByMac: async (mac, resolveJobId): Promise<DeviceRecord | null> => {
        const result = await this.deviceRecord.resolveDevice({ mac }, { jobId: resolveJobId });
        return isResolveOutcome(result) ? null : result;
      },
      getDeviceById: async (deviceId, deviceJobId) => {
        const deviceService = await createDeviceService(deviceJobId, {
          cache: this.redis,
          atomFetcher: this.atomFetcher(),
          getLiveNetplan: (id, netplanJobId) => this.netplanAtom.getLiveNetplan(id, { jobId: netplanJobId }),
        });
        const fetched = await deviceService.getDeviceById(deviceId);
        return Object.keys(fetched).length === 0 ? null : fetched;
      },
      buildBrokkrDiscoveryInitrd: async (buildJobId, deviceId, deviceData, outputName, clientIp) => {
        const buildService = await createBrokkrDiscoveryInitrdService(buildJobId, {
          fetchLiveNetplanForInitrd: (id, netplanJobId) =>
            fetchLiveNetplanForInitrd(this.netplanAtom, id, { jobId: netplanJobId }),
          createBridgeIpResolutionService: async () => this.bridgeIpResolver,
          getBridgeHostsEntriesForClient: (clientIp2, registryJobId, fallbackAddr) =>
            getBridgeHostsEntriesForClient(this.redis, clientIp2, { jobId: registryJobId, fallbackAddr }),
          getAllBridgeHostnames: (registryJobId) => getAllBridgeHostnames(this.redis, { jobId: registryJobId }),
          getBridgeRegistrySnapshot: (registryJobId) => getBridgeRegistrySnapshot(this.redis, { jobId: registryJobId }),
          agentTokens: this.agentTokens,
        });
        await buildService.buildBrokkrDiscoveryInitrd(buildJobId, deviceId, deviceData, outputName, clientIp);
      },
      buildUbuntuRescueOsInitrd: async (buildJobId, deviceId) => {
        const buildService = await createUbuntuRescueOsInitrdService(buildJobId, {
          cache: this.redis,
          fetchLiveNetplanForInitrd: (id, netplanJobId) =>
            fetchLiveNetplanForInitrd(this.netplanAtom, id, { jobId: netplanJobId }),
          getServerTokenAtom: this.serverTokenAtomFetcher(),
        });
        await buildService.buildUbuntuRescueOsInitrd(buildJobId, deviceId);
      },
    });
  }
}
