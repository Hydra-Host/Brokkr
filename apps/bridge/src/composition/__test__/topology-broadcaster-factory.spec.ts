import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionRegistry } from '../../agent/connection-registry/connection-registry.service.js';
import {
  buildEmptyBridgeRegistryReader,
  buildTopologyBroadcasterComposition,
  resetTopologyBroadcasterCompositionForTests,
} from '../topology-broadcaster-factory.js';

describe('topology broadcaster composition factory', () => {
  afterEach(() => {
    resetTopologyBroadcasterCompositionForTests();
  });

  it('shares one ConnectionRegistry instance between orchestrator surface and module options', () => {
    const composition = buildTopologyBroadcasterComposition({
      grpcConfig: { externalPort: 443 },
    });
    expect(composition.moduleOptions.registry).toBe(composition.registry);
    expect(composition.registry).toBeInstanceOf(ConnectionRegistry);
  });

  it('omits the direct service instance when no reader is supplied (production wires reader via DI)', () => {
    const composition = buildTopologyBroadcasterComposition({
      grpcConfig: { externalPort: 443 },
    });
    expect(composition.service).toBeNull();
    expect(composition.moduleOptions.reader).toBeUndefined();
  });

  it('broadcasts a topology envelope to a session handle registered against the shared registry', async () => {
    const reader = buildEmptyBridgeRegistryReader();
    const composition = buildTopologyBroadcasterComposition({
      grpcConfig: { externalPort: 443 },
      reader,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warning: () => undefined,
      },
    });
    const handle = await composition.registry.register('device-1', { peerIp: null });

    reader.getAllBridgeHostnames = async () => ['bridge-a'];
    reader.getBridgeRegistrySnapshot = async () => [];

    if (composition.service === null) throw new Error('expected service to be wired when reader is supplied');
    await composition.service.pollOnce('test-job');

    const msg = await handle.queue.get();
    expect(msg).toEqual(
      expect.objectContaining({
        topologyUpdate: expect.objectContaining({
          bridges: [{ address: 'bridge-a:443', bridgeId: 'bridge-a' }],
        }),
      }),
    );
  });
});
