import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordingMeterFake } from '../../__test__/telemetry-meter-fake';
import { ContextLogger } from '../../logger/logger.service';
import { buildLeaderConfig } from '../leader-election.config';
import {
  LeaderElectionService,
  type InterfaceEnumerator,
  type LeaderCache,
  type VersionInfo,
} from '../leader-election.service';

const holder = vi.hoisted((): { fake: RecordingMeterFake | null } => ({ fake: null }));

vi.mock('@repo/telemetry', async () => {
  const { createRecordingMeterFake } = await import('../../__test__/telemetry-meter-fake');
  const fake = createRecordingMeterFake();
  holder.fake = fake;
  return {
    getTelemetryMeter: () => fake.meter,
    emitTelemetryLog: vi.fn(),
    getBullMqTelemetry: () => undefined,
    isTelemetryEnabled: () => false,
    enrichActiveSpan: vi.fn(),
  };
});

let telemetryFake: RecordingMeterFake;

const TRANSITIONS = 'brokkr.leader.transitions';
const IS_LEADER = 'brokkr.leader.is_leader';

function makeCache(overrides: Partial<LeaderCache> = {}): LeaderCache {
  return {
    setNx: async () => false,
    renewIfOwner: async () => true,
    deleteIfOwner: async () => true,
    get: async () => null,
    hset: async () => 1,
    hgetall: async () => ({}),
    delete: async () => 1,
    scan: async () => [],
    ...overrides,
  };
}

const emptyInterfaces: InterfaceEnumerator = {
  async enumerate() {
    return [];
  },
};

const versions: () => VersionInfo = () => ({
  brokkrWorkerVersion: '0.0.0-test',
  brokkrLiveVersion: '0.0.0-live',
});

function makeService(cache: LeaderCache): LeaderElectionService {
  const config = buildLeaderConfig({ BRIDGE_HOSTNAME: 'metrics-instance' });
  return new LeaderElectionService(cache, emptyInterfaces, versions, new ContextLogger(), config, 'metrics');
}

describe('LeaderElectionService telemetry', () => {
  beforeEach(() => {
    const fake = holder.fake;
    if (fake === null) throw new Error('@repo/telemetry mock did not install the meter fake');
    telemetryFake = fake;
    telemetryFake.reset();
  });

  it('counts a leader transition and flips the gauge to 1 on election', async () => {
    const service = makeService(makeCache({ setNx: async () => true }));
    expect(await telemetryFake.collect(IS_LEADER)).toEqual([{ value: 0, attrs: undefined }]);

    await service.heartbeat();

    expect(telemetryFake.counters[TRANSITIONS]).toEqual([{ value: 1, attrs: { to: 'leader' } }]);
    expect(await telemetryFake.collect(IS_LEADER)).toEqual([{ value: 1, attrs: undefined }]);
  });

  it('counts a follower transition and drops the gauge to 0 when the renew is lost', async () => {
    const service = makeService(makeCache({ setNx: async () => true, renewIfOwner: async () => false }));
    await service.heartbeat();
    await service.heartbeat();

    expect(telemetryFake.counters[TRANSITIONS]).toEqual([
      { value: 1, attrs: { to: 'leader' } },
      { value: 1, attrs: { to: 'follower' } },
    ]);
    expect(await telemetryFake.collect(IS_LEADER)).toEqual([{ value: 0, attrs: undefined }]);
  });

  it('counts nothing when a follower stays follower', async () => {
    const service = makeService(makeCache());
    await service.heartbeat();
    await service.heartbeat();

    expect(telemetryFake.counters[TRANSITIONS]).toBeUndefined();
    expect(await telemetryFake.collect(IS_LEADER)).toEqual([{ value: 0, attrs: undefined }]);
  });

  it('counts the opportunistic vacant claim as a leader transition', async () => {
    const service = makeService(makeCache({ setNx: async () => true }));
    await service.tryClaimLeadershipIfVacant();

    expect(telemetryFake.counters[TRANSITIONS]).toEqual([{ value: 1, attrs: { to: 'leader' } }]);
  });

  it('counts a heartbeat timeout as a follower transition only when leader', async () => {
    const service = makeService(makeCache({ setNx: async () => true }));
    service.markHeartbeatTimedOut();
    expect(telemetryFake.counters[TRANSITIONS]).toBeUndefined();

    await service.heartbeat();
    service.markHeartbeatTimedOut();
    expect(telemetryFake.counters[TRANSITIONS]).toEqual([
      { value: 1, attrs: { to: 'leader' } },
      { value: 1, attrs: { to: 'follower' } },
    ]);
  });

  it('counts the shutdown release as a follower transition only when leader', async () => {
    const follower = makeService(makeCache());
    await follower.heartbeat();
    await follower.stop();
    expect(telemetryFake.counters[TRANSITIONS]).toBeUndefined();

    const leader = makeService(makeCache({ setNx: async () => true }));
    await leader.heartbeat();
    await leader.stop();
    expect(telemetryFake.counters[TRANSITIONS]).toEqual([
      { value: 1, attrs: { to: 'leader' } },
      { value: 1, attrs: { to: 'follower' } },
    ]);
  });
});
