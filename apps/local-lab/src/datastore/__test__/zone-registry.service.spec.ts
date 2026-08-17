import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type QueryArg = string | { text: string; values?: unknown[] };
type QueryResult = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
type ScriptedClient = { query: Mock<(arg: QueryArg) => Promise<QueryResult>>; release: Mock<() => void> };
type ScriptedPool = { connect: Mock<() => Promise<ScriptedClient>>; on: Mock<() => void>; end: Mock<() => void> };

const hp = vi.hoisted((): { pool: ScriptedPool } => ({
  pool: { connect: vi.fn(), on: vi.fn(), end: vi.fn() },
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      return hp.pool;
    }
  },
  types: {
    builtins: { TIMESTAMP: 1114 },
    setTypeParser: () => {},
    getTypeParser: () => (value: string) => value,
  },
}));

import { PgService } from '../pg.service';
import { ZoneRegistryService } from '../zone-registry.service';

function installPool(zoneRows: Record<string, unknown>[] | Error) {
  const query = vi.fn((arg: QueryArg): Promise<QueryResult> => {
    const text = typeof arg === 'string' ? arg : arg.text;
    if (text.includes('"Zone"')) {
      if (zoneRows instanceof Error) return Promise.reject(zoneRows);
      return Promise.resolve({ rows: zoneRows, fields: [{ name: 'id', dataTypeID: 25 }] });
    }
    if (text.includes('pg_type')) {
      return Promise.resolve({ rows: [{ oid: 25, name: 'text' }], fields: [] });
    }
    return Promise.resolve({ rows: [], fields: [] });
  });
  const client: ScriptedClient = { query, release: vi.fn() };
  hp.pool = { connect: vi.fn(() => Promise.resolve(client)), on: vi.fn(), end: vi.fn() };
}

const registry = () => new ZoneRegistryService(new PgService());

describe('ZoneRegistryService.listZoneIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns every configured zone id', async () => {
    installPool([{ id: 'zone-a' }, { id: 'zone-b' }]);
    await expect(registry().listZoneIds()).resolves.toEqual(['zone-a', 'zone-b']);
  });

  it('returns an empty list when no zones are configured', async () => {
    installPool([]);
    await expect(registry().listZoneIds()).resolves.toEqual([]);
  });

  it('drops rows whose id is absent, non-string or empty', async () => {
    installPool([{ id: 'zone-a' }, { id: null }, { id: '' }, { id: 7 }, {}]);
    await expect(registry().listZoneIds()).resolves.toEqual(['zone-a']);
  });

  it('degrades to an empty list when the zone read fails', async () => {
    installPool(new Error('pg down'));
    await expect(registry().listZoneIds()).resolves.toEqual([]);
  });
});

describe('ZoneRegistryService.listZones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the soft-delete column alongside id and name', async () => {
    installPool([{ id: 'zone-a', name: 'sim-zone', deletedAt: null }]);
    await expect(registry().listZones()).resolves.toEqual([{ id: 'zone-a', name: 'sim-zone', deletedAt: false }]);
  });

  it('normalises an unusable name to null rather than costing the row', async () => {
    installPool([{ id: 'zone-a', name: 7, deletedAt: null }]);
    await expect(registry().listZones()).resolves.toEqual([{ id: 'zone-a', name: null, deletedAt: false }]);
  });
});

describe('ZoneRegistryService.listLiveZones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes a deprovisioned zone, which has no bridges left to observe', async () => {
    installPool([
      { id: 'zone-a', name: 'sim-zone', deletedAt: null },
      { id: 'zone-b', name: 'old-zone', deletedAt: '2026-01-01T00:00:00Z' },
    ]);
    await expect((await registry().listLiveZones()).map((zone) => zone.id)).toEqual(['zone-a']);
  });

  it('keeps a deprovisioned zone in listZoneIds, so the saga in-flight guard cannot under-count', async () => {
    installPool([
      { id: 'zone-a', name: 'sim-zone', deletedAt: null },
      { id: 'zone-b', name: 'old-zone', deletedAt: '2026-01-01T00:00:00Z' },
    ]);
    await expect(registry().listZoneIds()).resolves.toEqual(['zone-a', 'zone-b']);
  });
});
