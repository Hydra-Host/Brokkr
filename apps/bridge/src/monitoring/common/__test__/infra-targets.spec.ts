import { describe, expect, it } from 'vitest';

import {
  KIND_CDU,
  KIND_PDU,
  KIND_SERVER,
  classifyRole,
  extractRole,
  iterClassifiedTargets,
  type ClassifiedTarget,
  type InfraTargetsCache,
  type InfraTargetsDeps,
} from '../infra-targets';

describe('extractRole', () => {
  it('nested role slug wins', () => {
    expect(extractRole({ role: { slug: 'PDU', name: 'Rack PDU' } })).toBe('pdu');
  });

  it('nested device_role slug', () => {
    expect(extractRole({ device_role: { slug: 'cdu' } })).toBe('cdu');
  });

  it('nested falls back to name when slug missing', () => {
    expect(extractRole({ role: { name: 'Server' } })).toBe('server');
  });

  it('flat string role', () => {
    expect(extractRole({ role: 'pdu' })).toBe('pdu');
  });

  it('absent role yields null', () => {
    expect(extractRole({ interfaces: [] })).toBeNull();
  });

  it('non-dict yields null', () => {
    expect(extractRole(null)).toBeNull();
    expect(extractRole('nope')).toBeNull();
  });
});

describe('classifyRole', () => {
  it('known pdu slugs', () => {
    expect(classifyRole('pdu')).toBe(KIND_PDU);
    expect(classifyRole('rack-pdu')).toBe(KIND_PDU);
  });

  it('known cdu slugs', () => {
    expect(classifyRole('cdu')).toBe(KIND_CDU);
    expect(classifyRole('coolant-distribution-unit')).toBe(KIND_CDU);
  });

  it('case insensitive', () => {
    expect(classifyRole('PDU')).toBe(KIND_PDU);
  });

  it('unknown role defaults to server', () => {
    expect(classifyRole('marketplace-hosts')).toBe(KIND_SERVER);
  });

  it('null/undefined defaults to server', () => {
    expect(classifyRole(null)).toBe(KIND_SERVER);
    expect(classifyRole(undefined)).toBe(KIND_SERVER);
  });
});

function makeDeps(ids: string[], data: Record<string, Record<string, unknown>>): InfraTargetsDeps {
  return {
    iterActiveDeviceIds: async function* () {
      for (const id of ids) yield id;
    },
    getCachedDeviceData: async (_cache, id) => data[id] ?? null,
  };
}

const NULL_CACHE: InfraTargetsCache = {
  scan: async () => [],
  get: async () => null,
};

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('iterClassifiedTargets', () => {
  it('classifies mixed fleet', async () => {
    const deps = makeDeps(['1', '2', '3'], {
      '1': { role: { slug: 'marketplace-hosts' } },
      '2': { role: { slug: 'pdu' } },
      '3': { device_role: { slug: 'cdu' } },
    });
    const targets = await collect(iterClassifiedTargets(NULL_CACHE, deps));
    const byId = Object.fromEntries(targets.map((t) => [t.deviceId, t]));
    expect(byId['1'].kind).toBe(KIND_SERVER);
    expect(byId['2'].kind).toBe(KIND_PDU);
    expect(byId['3'].kind).toBe(KIND_CDU);
    expect(byId['3'].role).toBe('cdu');
  });

  it('missing metadata defaults to server', async () => {
    const deps = makeDeps(['9'], {});
    const targets = await collect(iterClassifiedTargets(NULL_CACHE, deps));
    const expected: ClassifiedTarget = { deviceId: '9', role: null, kind: KIND_SERVER };
    expect(targets).toEqual([expected]);
  });
});
