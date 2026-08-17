import { describe, expect, it, vi } from 'vitest';

import { ContextLogger } from '../../logger/logger.service';
import type { BrokkrLiveConnectionRegistry } from '../brokkr-live.service';
import { BrokkrLiveService, BrokkrLiveServiceError, BrokkrLiveServiceFactory } from '../brokkr-live.service';

function mockRegistry(impl: Partial<BrokkrLiveConnectionRegistry> = {}): BrokkrLiveConnectionRegistry {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    ...impl,
  } as BrokkrLiveConnectionRegistry;
}

function makeLogger(): ContextLogger {
  return new ContextLogger();
}

describe('ConnectivityResult', () => {
  it('shape: success', async () => {
    const reg = mockRegistry({ isConnected: vi.fn().mockReturnValue(true) });
    const result = await new BrokkrLiveService('test-job-123', reg, makeLogger()).testDeviceConnectivity('d');
    expect(result.connected).toBe(true);
    expect(result.errorMessage).toBeNull();
  });

  it('shape: failure', async () => {
    const reg = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const result = await new BrokkrLiveService('test-job-123', reg, makeLogger()).testDeviceConnectivity('d');
    expect(result.connected).toBe(false);
    expect(result.errorMessage).toBe('agent not in connection map');
  });
});

describe('BrokkrLiveService', () => {
  it('initialization', () => {
    const service = new BrokkrLiveService('test-job-123', mockRegistry(), makeLogger());
    expect(service.jobId).toBe('test-job-123');
  });

  it('agent_connected_returns_connected', async () => {
    const isConnected = vi.fn().mockReturnValue(true);
    const service = new BrokkrLiveService('test-job-123', mockRegistry({ isConnected }), makeLogger());
    const result = await service.testDeviceConnectivity('device-123');
    expect(result.connected).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(isConnected).toHaveBeenCalledTimes(1);
    expect(isConnected).toHaveBeenCalledWith('device-123');
  });

  it('agent_not_connected_returns_not_connected', async () => {
    const isConnected = vi.fn().mockReturnValue(false);
    const service = new BrokkrLiveService('test-job-123', mockRegistry({ isConnected }), makeLogger());
    const result = await service.testDeviceConnectivity('device-456');
    expect(result.connected).toBe(false);
    expect(result.errorMessage).toBe('agent not in connection map');
  });

  it('connection_map_raises_wrapped_in_service_error', async () => {
    const isConnected = vi.fn().mockImplementation(() => {
      throw new Error('registry offline');
    });
    const service = new BrokkrLiveService('test-job-123', mockRegistry({ isConnected }), makeLogger());
    await expect(service.testDeviceConnectivity('device-789')).rejects.toThrow(BrokkrLiveServiceError);
    await expect(service.testDeviceConnectivity('device-789')).rejects.toThrow(/Connectivity test failed/);
  });

  it('device_id_is_stringified', async () => {
    const isConnected = vi.fn().mockReturnValue(true);
    const service = new BrokkrLiveService('test-job-123', mockRegistry({ isConnected }), makeLogger());
    await service.testDeviceConnectivity(12345);
    expect(isConnected).toHaveBeenCalledTimes(1);
    expect(isConnected).toHaveBeenCalledWith('12345');
  });
});

describe('BrokkrLiveServiceFactory', () => {
  it('create_brokkr_live_service', async () => {
    const registry = mockRegistry();
    const factory = new BrokkrLiveServiceFactory(registry as never, makeLogger());
    const service = await factory.create('job-id');
    expect(service).toBeInstanceOf(BrokkrLiveService);
    expect(service.jobId).toBe('job-id');
  });

  it('create_brokkr_live_service_default_job_id', async () => {
    const registry = mockRegistry();
    const factory = new BrokkrLiveServiceFactory(registry as never, makeLogger());
    const service = await factory.create();
    expect(service.jobId).toBe('');
  });
});
