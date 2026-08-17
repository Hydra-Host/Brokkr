import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ZoneRuntimeSchema } from '../../contract';
import { ZoneRuntimeService } from '../zone-runtime.service';

const ZONE = '00000000-0000-0000-0000-111111111111';

const okVrrp = () => ({
  observability: 'shim' as const,
  vips: [
    {
      prefixId: 'prefix-1',
      vip: '10.0.1.1/24',
      ifaceByBridge: { spoke: 'eth0' },
      garpCount: null,
      writtenAtMs: 1_700_000_000_000,
      requestId: null,
      desiredHolder: null,
      observedHolders: ['spoke'],
      atomError: null,
    },
  ],
  readError: null,
});

function makeDeps() {
  return {
    zoneRegistry: { listLiveZones: vi.fn(() => Promise.resolve([{ id: ZONE, name: 'sim-zone', deletedAt: false }])) },
    overlay: { labBridges: vi.fn(() => [{ proc: 'spoke', zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 }]) },
    leaderReader: {
      leader: vi.fn(() => Promise.resolve({ holder: 'spoke', ttlSeconds: 28, readError: null })),
      presence: vi.fn(() =>
        Promise.resolve([
          {
            instanceId: 'spoke',
            hash: { instance_id: 'spoke', is_leader: 'True', registered_at: String(Date.now() / 1000) },
          },
        ]),
      ),
    },
    vrrpReader: { read: vi.fn(() => Promise.resolve(okVrrp())) },
    cryptoReader: {
      read: vi.fn(() =>
        Promise.resolve({ state: 'enrolled' as const, bootstrapLockTtlSeconds: null, readError: null }),
      ),
    },
    agentWorkReader: {
      read: vi.fn(() =>
        Promise.resolve({ dispatchesInFlight: 0, lastActivityAtMs: null, scanCapped: false, readError: null }),
      ),
    },
  };
}

let deps: ReturnType<typeof makeDeps>;

const makeService = () =>
  new ZoneRuntimeService(
    deps.zoneRegistry as never,
    deps.overlay as never,
    deps.leaderReader as never,
    deps.vrrpReader as never,
    deps.cryptoReader as never,
    deps.agentWorkReader as never,
  );

beforeEach(() => {
  deps = makeDeps();
});

describe('ZoneRuntimeService', () => {
  it('assembles a zone that matches the published contract', async () => {
    const [zone] = await makeService().list();

    expect(() => ZoneRuntimeSchema.parse(zone)).not.toThrow();
    expect(zone).toMatchObject({ zoneId: ZONE, zoneName: 'sim-zone' });
  });

  it('applies the desired holder once it holds both the leader and the atom', async () => {
    const [zone] = await makeService().list();

    expect(zone.vrrp.vips[0].desiredHolder).toBe('spoke');
  });

  it('names no desired holder when the leader is not given an interface', async () => {
    deps.leaderReader.leader = vi.fn(() => Promise.resolve({ holder: 'spoke-9', ttlSeconds: 28, readError: null }));

    const [zone] = await makeService().list();

    expect(zone.vrrp.vips[0].desiredHolder).toBeNull();
  });

  it('joins configured ports onto the registered bridge', async () => {
    const [zone] = await makeService().list();

    expect(zone.bridges.rows[0]).toMatchObject({
      instanceId: 'spoke',
      expected: true,
      registered: true,
      port: 8000,
      grpcPort: 9082,
    });
  });

  it('does not report another zone\'s bridge as holding this zone\'s vip', async () => {
    deps.vrrpReader.read = vi.fn(() =>
      Promise.resolve({ ...okVrrp(), vips: [{ ...okVrrp().vips[0], observedHolders: ['spoke', 'other-zone-spoke'] }] }),
    );

    const [zone] = await makeService().list();

    expect(zone.vrrp.vips[0].observedHolders).toEqual(['spoke']);
  });

  it('leaves holders undetermined when the bridge list it would scope against could not be read', async () => {
    deps.leaderReader.presence = vi.fn(() => Promise.reject(new Error('presence down')));

    const [zone] = await makeService().list();

    expect(zone.vrrp.vips[0].observedHolders).toBeNull();
  });

  it('keeps the other sections when the vrrp read throws', async () => {
    deps.vrrpReader.read = vi.fn(() => Promise.reject(new Error('vrrp down')));

    const [zone] = await makeService().list();

    expect(zone.vrrp.readError).toBeTruthy();
    expect(zone.vrrp.observability).toBe('unavailable');
    expect(zone.leader.holder).toBe('spoke');
    expect(zone.zoneCrypto.state).toBe('enrolled');
    expect(zone.bridges.rows).toHaveLength(1);
  });

  it('keeps the other sections when the zone-crypto probe throws', async () => {
    deps.cryptoReader.read = vi.fn(() => Promise.reject(new Error('crypto down')));

    const [zone] = await makeService().list();

    expect(zone.zoneCrypto.state).toBe('unknown');
    expect(zone.leader.holder).toBe('spoke');
    expect(zone.vrrp.vips).toHaveLength(1);
  });

  it('reports a failed presence read on the bridges section, leaving the zone row clean', async () => {
    deps.leaderReader.presence = vi.fn(() => Promise.reject(new Error('presence down')));

    const [zone] = await makeService().list();

    expect(zone.bridges.rows).toEqual([]);
    expect(zone.bridges.readError).toBeTruthy();
    expect(zone.readError).toBeNull();
  });

  it('does not attribute a bridge from another zone to this one', async () => {
    deps.overlay.labBridges = vi.fn(() => [{ proc: 'other', zone: 'sim-zone2', replica: 0, port: 8001, grpc: 9083 }]);

    const [zone] = await makeService().list();

    expect(zone.bridges.rows.map((bridge) => bridge.instanceId)).toEqual(['spoke']);
    expect(zone.bridges.rows[0].expected).toBe(false);
  });

  it('leaves every section unknown when the whole zone read fails', async () => {
    deps.leaderReader.leader = vi.fn(() => Promise.reject(new Error('redis gone')));

    const [zone] = await makeService().list();

    expect(zone.readError).toContain('redis gone');
    expect(zone.zoneCrypto.state).toBe('unknown');
    expect(zone.agentWork.dispatchesInFlight).toBeNull();
    expect(() => ZoneRuntimeSchema.parse(zone)).not.toThrow();
  });
});
