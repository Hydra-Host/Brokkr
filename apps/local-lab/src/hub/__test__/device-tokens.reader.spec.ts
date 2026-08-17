import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceTokensReaderService } from '../device-tokens.reader';

const NOW = new Date('2026-01-02T03:04:05.000Z');

const sqlRow = (over: Record<string, unknown> = {}) => ({
  id: 'tok-1',
  displayId: 'dtok_0123456789ab',
  deviceId: 'dev-1',
  deploymentId: null,
  context: 'BROKKR_LIVE',
  status: 'ACTIVE',
  rotationGeneration: 0,
  expiresAt: null,
  lastUsedAt: NOW,
  lastUsedIp: '127.0.0.1',
  revokedAt: null,
  revokedReason: null,
  issuedBy: null,
  createdAt: NOW,
  ...over,
});

let pgRows: Record<string, unknown>[];
let pgError: Error | null;
let execReplies: [Error | null, unknown][] | null;
let execError: Error | null;
let multiCalls: string[];

function makePg() {
  return {
    readTyped: vi.fn(
      (
        _sql: string,
        _params: unknown[],
        schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
      ) => {
        if (pgError) return Promise.reject(pgError);
        const rows: unknown[] = [];
        let skipped = 0;
        for (const raw of pgRows) {
          const parsed = schema.safeParse(raw);
          if (parsed.success) rows.push(parsed.data);
          else skipped += 1;
        }
        return Promise.resolve({ rows, skipped });
      },
    ),
  };
}

function makeConnections() {
  return {
    client: vi.fn(() => ({
      multi: vi.fn(() => ({
        exists: vi.fn((key: string) => {
          multiCalls.push(key);
        }),
        exec: vi.fn(() => (execError ? Promise.reject(execError) : Promise.resolve(execReplies))),
      })),
    })),
  };
}

let pg: ReturnType<typeof makePg>;
let connections: ReturnType<typeof makeConnections>;

const makeReader = () => new DeviceTokensReaderService(pg as never, connections as never);
const query = { deviceId: null, status: null, limit: 50, offset: 0 };

beforeEach(() => {
  pgRows = [sqlRow()];
  pgError = null;
  execReplies = [[null, 1]];
  execError = null;
  multiCalls = [];
  pg = makePg();
  connections = makeConnections();
});

describe('DeviceTokensReaderService.list', () => {
  it('reports the token by its display id and never carries a hash', async () => {
    const page = await makeReader().list(query);

    expect(page.rows[0].displayId).toBe('dtok_0123456789ab');
    expect(page.rows[0]).not.toHaveProperty('tokenHash');
  });

  it('reports the live sentinel as fresher evidence than the throttled column', async () => {
    const page = await makeReader().list(query);

    expect(page.rows[0].lastUsedAtMs).toBe(NOW.getTime());
    expect(page.rows[0].usedWithinThrottleWindow).toBe(true);
    expect(page.recencyReadError).toBeNull();
  });

  it('probes the global last-used key, which carries no zone prefix', async () => {
    await makeReader().list(query);

    expect(multiCalls).toEqual(['device-token:tok-1:last-used']);
  });

  it('reads a missing sentinel as a measured false', async () => {
    execReplies = [[null, 0]];

    const page = await makeReader().list(query);

    expect(page.rows[0].usedWithinThrottleWindow).toBe(false);
  });

  it('leaves recency undetermined rather than idle when the sentinel probe fails', async () => {
    execError = new Error('ECONNREFUSED');

    const page = await makeReader().list(query);

    expect(page.rows[0].usedWithinThrottleWindow).toBeNull();
    expect(page.recencyReadError).toContain('ECONNREFUSED');
    expect(page.readError).toBeNull();
  });

  it('leaves one token undetermined when the probe ran but that key errored, rather than calling it idle', async () => {
    pgRows = [sqlRow(), sqlRow({ id: 'tok-2', displayId: 'dtok_ffffffffffff' })];
    execReplies = [
      [null, 1],
      [new Error('WRONGTYPE'), null],
    ];

    const page = await makeReader().list(query);

    expect(page.rows[0].usedWithinThrottleWindow).toBe(true);
    expect(page.rows[1].usedWithinThrottleWindow).toBeNull();
    expect(page.recencyReadError).toBeNull();
  });

  it('leaves a token undetermined when redis returns fewer replies than keys probed', async () => {
    pgRows = [sqlRow(), sqlRow({ id: 'tok-2', displayId: 'dtok_ffffffffffff' })];
    execReplies = [[null, 0]];

    const page = await makeReader().list(query);

    expect(page.rows[0].usedWithinThrottleWindow).toBe(false);
    expect(page.rows[1].usedWithinThrottleWindow).toBeNull();
  });

  it('leaves recency undetermined when redis answers with no replies at all', async () => {
    execReplies = null;

    const page = await makeReader().list(query);

    expect(page.rows[0].usedWithinThrottleWindow).toBeNull();
    expect(page.recencyReadError).toBeTruthy();
  });

  it('keeps a never-used token distinct from one whose sentinel could not be read', async () => {
    pgRows = [sqlRow({ lastUsedAt: null })];
    const never = await makeReader().list(query);

    execError = new Error('boom');
    pg = makePg();
    connections = makeConnections();
    const unknown = await makeReader().list(query);

    expect(never.rows[0].lastUsedAtMs).toBeNull();
    expect(never.rows[0].usedWithinThrottleWindow).toBe(true);
    expect(unknown.rows[0].usedWithinThrottleWindow).toBeNull();
  });

  it('reports an empty list as unknown rather than none when the token read fails', async () => {
    pgError = new Error('pg down');

    const page = await makeReader().list(query);

    expect(page.rows).toEqual([]);
    expect(page.readError).toContain('pg down');
    expect(page.recencyReadError).toBeNull();
  });

  it('does not probe redis at all when there are no tokens to probe', async () => {
    pgRows = [];

    const page = await makeReader().list(query);

    expect(multiCalls).toEqual([]);
    expect(page.recencyReadError).toBeNull();
  });

  it('counts a row it cannot parse rather than shortening the list silently', async () => {
    pgRows = [sqlRow(), sqlRow({ id: '' })];

    const page = await makeReader().list(query);

    expect(page.rows).toHaveLength(1);
    expect(page.skipped).toBe(1);
  });
});

describe('DeviceTokensReaderService.events', () => {
  it('reports an unreadable audit trail as unknown rather than empty', async () => {
    pgError = new Error('pg down');

    const page = await makeReader().events('tok-1', 50, 0);

    expect(page.rows).toEqual([]);
    expect(page.readError).toContain('pg down');
  });
});
