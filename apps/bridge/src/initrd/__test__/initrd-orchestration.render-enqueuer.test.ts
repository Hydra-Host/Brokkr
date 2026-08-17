import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentTokenService } from '../../auth/agent-token.service.js';
import type { BridgeIpResolutionService } from '../../bridge-network/bridge-ip-resolution.service.js';
import type { NetplanAtomService } from '../../bridge-network/netplan-atom.service.js';
import type { RedisService } from '../../common/redis/redis.service.js';
import type { EnqueueRenderRequest, EnqueueRenderRequestParams } from '../../device-record/atom/atom-fetcher.js';
import type { DeviceRecordService } from '../../device-record/device-record.service.js';
import { InitrdOrchestrationService } from '../initrd-orchestration.service.js';

function makeColdCache(): RedisService {
  return {
    get: vi.fn(async (_key: string, _jobId?: string) => null),
    delete: vi.fn(async (_key: string, _jobId?: string) => 1),
  } as unknown as RedisService;
}

describe('InitrdOrchestrationService — render enqueuer wiring', () => {
  it('invokes the injected enqueuer when serverTokenAtomFetcher hits a cold cache', async () => {
    const cache = makeColdCache();
    const enqueueRenderRequest: EnqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => false);

    const service = new InitrdOrchestrationService(
      cache,
      {} as DeviceRecordService,
      {} as NetplanAtomService,
      {} as BridgeIpResolutionService,
      {} as AgentTokenService,
      enqueueRenderRequest,
    );

    const fetcher = (
      service as unknown as {
        serverTokenAtomFetcher(): import('../phone-home.service.js').ServerTokenAtomFetcher;
      }
    ).serverTokenAtomFetcher();

    const result = await fetcher({
      domain: 'server_token',
      entityId: 'device-1',
      atomKey: 'device:server_token:device-1',
      jobId: 'test-job',
    });

    expect(result).toBeNull();
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
    const call = vi.mocked(enqueueRenderRequest).mock.calls[0][0];
    expect(call.domain).toBe('server_token');
    expect(call.entityId).toBe('device-1');
  });

  it('invokes the injected enqueuer when atomFetcher.getAtom hits a cold cache', async () => {
    const cache = makeColdCache();
    const enqueueRenderRequest: EnqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => false);

    const service = new InitrdOrchestrationService(
      cache,
      {} as DeviceRecordService,
      {} as NetplanAtomService,
      {} as BridgeIpResolutionService,
      {} as AgentTokenService,
      enqueueRenderRequest,
    );

    const fetcher = (
      service as unknown as {
        atomFetcher(): import('../../devices/device.service.js').AtomFetcherLike;
      }
    ).atomFetcher();

    const recordSchema = z.object({}).passthrough();
    const result = await fetcher.getAtom({
      domain: 'device_record',
      entityId: 'device-2',
      atomKey: 'device:record:device-2',
      valueSchema: recordSchema,
      jobId: 'test-job',
    });

    expect(result).toBeNull();
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
    const call = vi.mocked(enqueueRenderRequest).mock.calls[0][0];
    expect(call.domain).toBe('device_record');
    expect(call.entityId).toBe('device-2');
  });
});

describe('InitrdOrchestrationService.resolveDownloadByPath — path-traversal guard', () => {
  function makeService(): InitrdOrchestrationService {
    return new InitrdOrchestrationService(
      makeColdCache(),
      {} as DeviceRecordService,
      {} as NetplanAtomService,
      {} as BridgeIpResolutionService,
      {} as AgentTokenService,
      vi.fn(async () => false),
    );
  }

  it('rejects a percent-decoded traversal name as invalid before touching the serving service', async () => {
    const service = makeService();
    const createSpy = vi.spyOn(service, 'createServingService');

    const result = await service.resolveDownloadByPath('job', 'brokkr-discovery-../../secret.img', '10.0.0.1');

    expect(result).toEqual({ initrdFile: null, scheduleCleanup: false, secretBearing: false, invalidBuildName: true });
    expect(createSpy).not.toHaveBeenCalled();
  });
});
