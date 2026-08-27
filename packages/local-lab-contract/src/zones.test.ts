import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';

import { contract } from './index';
import {
  RESERVED_ZONE_NAME,
  ZONE_INDEX_MAX,
  ZONE_INDEX_MIN,
  ZoneSchema,
  ZonesConfigSchema,
  ZoneWriteSchema,
} from './schemas/zones';

const zone = (over: Record<string, unknown> = {}) => ({
  name: 'sim-zone',
  index: 0,
  bridges: 1,
  baseDeclared: true,
  derived: {
    uuid: '00000000-0000-0000-0000-111111111111',
    ordinals: [0],
    bridges: [{ proc: 'spoke', port: 8000, grpc: 9082 }],
    nodeCount: 4,
  },
  ...over,
});

describe('ZoneWriteSchema', () => {
  it('bounds the index to the range the uuid derivation covers', () => {
    expect(ZoneWriteSchema.parse({ name: 'edge', index: ZONE_INDEX_MAX, bridges: 1 }).index).toBe(ZONE_INDEX_MAX);
    expect(() => ZoneWriteSchema.parse({ name: 'edge', index: ZONE_INDEX_MAX + 1, bridges: 1 })).toThrow();
    expect(() => ZoneWriteSchema.parse({ name: 'edge', index: ZONE_INDEX_MIN - 1, bridges: 1 })).toThrow();
  });

  it('refuses a zone with no bridges, which would start no spoke at all', () => {
    expect(() => ZoneWriteSchema.parse({ name: 'edge', index: 1, bridges: 0 })).toThrow();
  });

  it('refuses the characters that would break the token path or the redis dsn', () => {
    for (const name of ['../escape', 'a/b', 'has@at', 'has:colon', 'Upper', 'has space', '-leading']) {
      expect(() => ZoneWriteSchema.parse({ name, index: 1, bridges: 1 })).toThrow();
    }
  });

  it('accepts the names the fleet fixtures already use', () => {
    for (const name of ['sim-zone', 'den-1', 'zone-1', 'edge']) {
      expect(ZoneWriteSchema.parse({ name, index: 1, bridges: 1 }).name).toBe(name);
    }
  });

  it('refuses a blank name, which is not an attribute key', () => {
    expect(() => ZoneWriteSchema.parse({ name: '', index: 1, bridges: 1 })).toThrow();
  });

  it('accepts a free-form name, because zone_name(index) is a default and not a constraint', () => {
    expect(ZoneWriteSchema.parse({ name: 'den-1', index: 1, bridges: 2 }).name).toBe('den-1');
  });
});

describe('ZoneSchema', () => {
  it('keeps what the overlay sets separate from what Nix derives', () => {
    const parsed = ZoneSchema.parse(zone());
    expect(Object.keys(parsed)).toEqual(['name', 'index', 'bridges', 'baseDeclared', 'derived']);
    expect(parsed.derived.ordinals).toEqual([0]);
  });

  it('requires the derived block, so a zone can never be shown without its consequences', () => {
    const { derived, ...without } = zone();
    void derived;
    expect(() => ZoneSchema.parse(without)).toThrow();
  });
});

describe('ZonesConfigSchema', () => {
  const config = (over: Record<string, unknown> = {}) => ({
    seeded: true,
    zones: [zone()],
    capacity: { used: 1, total: 25 },
    reservedNames: [RESERVED_ZONE_NAME],
    reconcile: [],
    hubReadError: null,
    ...over,
  });

  it('tells an unreadable hub from one that agrees, which an empty list alone cannot', () => {
    expect(ZonesConfigSchema.parse(config()).hubReadError).toBeNull();
    expect(ZonesConfigSchema.parse(config({ hubReadError: 'connection refused' })).hubReadError).toBe(
      'connection refused',
    );
  });

  it('marks the seeded fixture rather than reporting it as drift', () => {
    const parsed = ZonesConfigSchema.parse(
      config({
        reconcile: [{ name: RESERVED_ZONE_NAME, zoneId: 'abc', side: 'hub-only', fixture: true }],
      }),
    );
    expect(parsed.reconcile[0]).toMatchObject({ fixture: true, side: 'hub-only' });
  });

  it('carries the ordinal budget rather than leaving the client to guess it', () => {
    expect(ZonesConfigSchema.parse(config()).capacity).toEqual({ used: 1, total: 25 });
  });
});

describe('putZonesConfig', () => {
  const body = () => {
    const route = contract.putZonesConfig;
    if (!isAppRoute(route) || !route.body) throw new Error('putZonesConfig has no body');
    return route.body;
  };

  it('refuses an empty zone set outright, before any service rule runs', () => {
    expect(() => body().parse({ zones: [] })).toThrow();
  });

  it('takes a rename as its own field, because the desired set cannot express one', () => {
    const parsed = body().parse({
      zones: [{ name: 'edge', index: 1, bridges: 1 }],
      rename: { from: 'sim-zone', to: 'edge' },
    });
    expect(parsed.rename).toEqual({ from: 'sim-zone', to: 'edge' });
    expect(body().parse({ zones: [{ name: 'edge', index: 1, bridges: 1 }] }).rename).toBeUndefined();
  });

  it('carries node zones in the same write, which a second zone requires', () => {
    const parsed = body().parse({
      zones: [
        { name: 'sim-zone', index: 0, bridges: 1 },
        { name: 'edge', index: 1, bridges: 1 },
      ],
      nodeZones: { 'cpu-1': 'sim-zone', 'gpu-1': 'edge' },
    });
    expect(parsed.nodeZones).toEqual({ 'cpu-1': 'sim-zone', 'gpu-1': 'edge' });
  });

  it('declares the refusal and the blocked-seed responses it can return', () => {
    const route = contract.putZonesConfig;
    if (!isAppRoute(route)) throw new Error('not a route');
    expect(route.responses[400]).toBeDefined();
    expect(route.responses[503]).toBeDefined();
  });

  it('says it is loopback-only, which the exposure guard asserts separately', () => {
    expect(contract.putZonesConfig.description).toMatch(/loopback-only/i);
  });
});
