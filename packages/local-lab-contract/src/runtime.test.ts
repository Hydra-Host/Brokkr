import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { ZoneRuntimeSchema, ZoneVipSchema } from './schemas/runtime';

const vip = (over: Record<string, unknown> = {}) => ({
  prefixId: 'prefix-1',
  vip: '10.0.1.1/24',
  ifaceByBridge: { spoke: 'eth0' },
  garpCount: null,
  writtenAtMs: 1_700_000_000_000,
  requestId: null,
  desiredHolder: 'spoke',
  observedHolders: ['spoke'],
  atomError: null,
  ...over,
});

const zone = (over: Record<string, unknown> = {}) => ({
  zoneId: '00000000-0000-0000-0000-111111111111',
  zoneName: 'sim-zone',
  leader: { holder: 'spoke', ttlSeconds: 28, readError: null },
  bridges: { rows: [], readError: null },
  vrrp: { observability: 'shim', vips: [], readError: null },
  zoneCrypto: { state: 'enrolled', bootstrapLockTtlSeconds: null, readError: null },
  agentWork: { dispatchesInFlight: 0, lastActivityAtMs: null, scanCapped: false, readError: null },
  readError: null,
  ...over,
});

describe('ZoneRuntimeSchema', () => {
  it('accepts a fully measured zone', () => {
    expect(ZoneRuntimeSchema.parse(zone())).toMatchObject({ zoneId: '00000000-0000-0000-0000-111111111111' });
  });

  it('requires every nullable field to be stated rather than omitted', () => {
    const { readError, ...withoutReadError } = zone();
    expect(readError).toBeNull();
    expect(ZoneRuntimeSchema.safeParse(withoutReadError).success).toBe(false);
  });

  it('rejects a zone-crypto state outside the documented vocabulary', () => {
    expect(
      ZoneRuntimeSchema.safeParse(
        zone({ zoneCrypto: { state: 'enrolling', bootstrapLockTtlSeconds: null, readError: null } }),
      ).success,
    ).toBe(false);
  });

  it('rejects a vrrp observability value outside the documented vocabulary', () => {
    expect(
      ZoneRuntimeSchema.safeParse(zone({ vrrp: { observability: 'kernel', vips: [], readError: null } })).success,
    ).toBe(false);
  });
});

describe('ZoneVipSchema unreadable atoms', () => {
  it('lets an unreadable atom say so rather than reporting a blank address at the epoch', () => {
    const unreadable = ZoneVipSchema.parse(
      vip({
        vip: null,
        writtenAtMs: null,
        ifaceByBridge: {},
        desiredHolder: null,
        observedHolders: null,
        atomError: 'bad envelope',
      }),
    );

    expect(unreadable.vip).toBeNull();
    expect(unreadable.writtenAtMs).toBeNull();
  });

  it('still rejects an omitted address, so unreadable is always spelled out', () => {
    const { vip: address, ...withoutAddress } = vip();
    expect(address).toBe('10.0.1.1/24');
    expect(ZoneVipSchema.safeParse(withoutAddress).success).toBe(false);
  });
});

describe('ZoneRuntimeSchema agent work', () => {
  it('keeps an undetermined scan cap distinct from a complete scan', () => {
    const failed = ZoneRuntimeSchema.parse(
      zone({ agentWork: { dispatchesInFlight: null, lastActivityAtMs: null, scanCapped: null, readError: 'boom' } }),
    );
    const complete = ZoneRuntimeSchema.parse(zone());

    expect(failed.agentWork.scanCapped).toBeNull();
    expect(complete.agentWork.scanCapped).toBe(false);
  });
});

describe('ZoneRuntimeSchema bridges', () => {
  it('keeps an unreadable bridge list distinguishable from a zone with no bridges', () => {
    const none = ZoneRuntimeSchema.parse(zone({ bridges: { rows: [], readError: null } }));
    const unknown = ZoneRuntimeSchema.parse(zone({ bridges: { rows: [], readError: 'ECONNREFUSED' } }));

    expect(none.bridges.readError).toBeNull();
    expect(unknown.bridges.readError).toBe('ECONNREFUSED');
    expect(none.bridges).not.toEqual(unknown.bridges);
  });

  it('rejects a bare array, so the error channel cannot be dropped by a caller', () => {
    expect(ZoneRuntimeSchema.safeParse(zone({ bridges: [] })).success).toBe(false);
  });
});

describe('ZoneVipSchema observedHolders', () => {
  it('keeps unobserved and observed-as-nobody as distinct values', () => {
    const unobserved = ZoneVipSchema.parse(vip({ observedHolders: null }));
    const nobody = ZoneVipSchema.parse(vip({ observedHolders: [] }));

    expect(unobserved.observedHolders).toBeNull();
    expect(nobody.observedHolders).toEqual([]);
    expect(unobserved.observedHolders).not.toEqual(nobody.observedHolders);
  });

  it('rejects an omitted observedHolders, so unobserved is always spelled out', () => {
    const { observedHolders, ...withoutHolders } = vip();
    expect(observedHolders).toEqual(['spoke']);
    expect(ZoneVipSchema.safeParse(withoutHolders).success).toBe(false);
  });
});

describe('listZoneRuntimes route', () => {
  it('is a GET, so the surface stays read-only', () => {
    const route = contract.listZoneRuntimes;
    if (!isAppRoute(route)) throw new Error('listZoneRuntimes route missing');
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/api/runtime/zones');
  });

  it('documents that agent sessions are not observable here, and does not merely mention them', () => {
    const route = contract.listZoneRuntimes;
    if (!isAppRoute(route)) throw new Error('listZoneRuntimes route missing');
    const description = route.description ?? '';

    expect(description).toMatch(/cannot see live-agent grpc sessions/i);
    expect(description).toMatch(/not be read as session liveness/i);
  });

  it('documents that the zone-crypto value itself is never read', () => {
    const route = contract.listZoneRuntimes;
    if (!isAppRoute(route)) throw new Error('listZoneRuntimes route missing');

    expect(route.description ?? '').toMatch(/presence only/i);
  });
});
