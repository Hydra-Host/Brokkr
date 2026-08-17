import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DiscoveryIngressService } from '../discovery-ingress.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const ZONE = '00000000-0000-0000-0000-111111111111';
const OTHER_ZONE = '00000000-0000-0000-0000-222222222222';

interface Mocks {
  redis: { mget: Mock; del: Mock };
  prisma: { device: { findUnique: Mock } };
  orchestrator: { runDiscovery: Mock };
  qualify: { handleQualifyFailure: Mock };
}

function build(mocks: Mocks): DiscoveryIngressService {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new DiscoveryIngressService(
    mocks.redis as never,
    mocks.prisma as never,
    mocks.orchestrator as never,
    mocks.qualify as never,
    logger as never,
  );
}

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    device_id: DEVICE_UUID,
    zone_prefix: ZONE,
    fields: ['lscpu'],
    job_id: 'plan-1',
    ...overrides,
  };
}

describe('DiscoveryIngressService — zone correlation', () => {
  let mocks: Mocks;

  beforeEach(() => {
    mocks = {
      redis: { mget: vi.fn().mockResolvedValue(['{"sockets":2}']), del: vi.fn().mockResolvedValue(1) },
      prisma: { device: { findUnique: vi.fn().mockResolvedValue({ id: DEVICE_UUID, zoneId: ZONE }) } },
      orchestrator: { runDiscovery: vi.fn().mockResolvedValue(undefined) },
      qualify: { handleQualifyFailure: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it('runs discovery when the device belongs to the message zone', async () => {
    await build(mocks).handleDiscoveryComplete(makeData());
    expect(mocks.orchestrator.runDiscovery).toHaveBeenCalledTimes(1);
  });

  it('discards (no discovery run) when the device belongs to a different zone', async () => {
    mocks.prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, zoneId: OTHER_ZONE });

    await build(mocks).handleDiscoveryComplete(makeData({ zone_prefix: ZONE }));

    expect(mocks.orchestrator.runDiscovery).not.toHaveBeenCalled();
    expect(mocks.redis.del).toHaveBeenCalled();
  });
});
