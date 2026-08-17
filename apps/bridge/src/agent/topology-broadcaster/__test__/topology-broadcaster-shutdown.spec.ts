import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../gateway/grpc.config', () => ({
  getGrpcConfig: () => ({ enabled: true }),
}));

import { TopologyBroadcasterModule } from '../topology-broadcaster.module';
import { TopologyBroadcasterService } from '../topology-broadcaster.service';
import type {
  BridgeRegistryReaderPort,
  BridgeSnapshot,
  ConnectionRegistryPort,
  GrpcConfigPort,
  SessionHandle,
  TopologyBroadcasterLogger,
} from '../topology-broadcaster.types';

const POLL_INTERVAL_MS = 30_000;

const emptyRegistry: ConnectionRegistryPort = {
  snapshotSessionHandles: async (): Promise<readonly SessionHandle[]> => [],
};

const silentLogger: TopologyBroadcasterLogger = {
  debug: () => undefined,
  info: () => undefined,
  warning: () => undefined,
};

const grpcCfg: GrpcConfigPort = { externalPort: 443 };

class FastReader implements BridgeRegistryReaderPort {
  ticks = 0;
  async getAllBridgeHostnames(_jobId: string): Promise<readonly string[]> {
    this.ticks += 1;
    return ['bridge-a'];
  }
  async getBridgeRegistrySnapshot(_jobId: string): Promise<BridgeSnapshot> {
    return [];
  }
}

class BlockingReader implements BridgeRegistryReaderPort {
  inTick = false;
  private release: (() => void) | null = null;
  async getAllBridgeHostnames(_jobId: string): Promise<readonly string[]> {
    this.inTick = true;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.inTick = false;
    return ['bridge-a'];
  }
  async getBridgeRegistrySnapshot(_jobId: string): Promise<BridgeSnapshot> {
    return [];
  }
  releaseTick(): void {
    this.release?.();
    this.release = null;
  }
}

function buildService(reader: BridgeRegistryReaderPort): TopologyBroadcasterService {
  return new TopologyBroadcasterService(emptyRegistry, reader, grpcCfg, silentLogger, POLL_INTERVAL_MS);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('TopologyBroadcasterService.stop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wakes the poll sleep so runForever resolves without the interval elapsing', async () => {
    vi.useFakeTimers();
    const reader = new FastReader();
    const service = buildService(reader);

    const running = service.runForever('job-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reader.ticks).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    service.stop();

    await expect(running).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(reader.ticks).toBe(1);
  });

  it('leaves no pending sleep when called between ticks', async () => {
    vi.useFakeTimers();
    const service = buildService(new FastReader());

    const running = service.runForever('job-1');
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    await running;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TopologyBroadcasterModule.onApplicationShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins the running loop instead of returning while it is mid-tick', async () => {
    const reader = new BlockingReader();
    const module = new TopologyBroadcasterModule(buildService(reader));

    module.onApplicationBootstrap();
    await flush();
    expect(reader.inTick).toBe(true);

    let joined = false;
    const shutdown = module.onApplicationShutdown().then(() => {
      joined = true;
    });
    await flush();
    expect(joined).toBe(false);

    reader.releaseTick();
    await shutdown;

    expect(joined).toBe(true);
    expect(reader.inTick).toBe(false);
  });

  it('resolves immediately when the loop was never started', async () => {
    const module = new TopologyBroadcasterModule(buildService(new FastReader()));

    await expect(module.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('abandons the join when the loop stays wedged past the bound', async () => {
    vi.useFakeTimers();
    const reader = new BlockingReader();
    const module = new TopologyBroadcasterModule(buildService(reader));

    module.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    const shutdown = module.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(shutdown).resolves.toBeUndefined();
    expect(reader.inTick).toBe(true);
  });
});
