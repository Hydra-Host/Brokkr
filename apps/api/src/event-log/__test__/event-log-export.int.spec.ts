import type { EventLogEntry, EventLogQuery } from '@repo/api-client';
import { Prisma, createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cursorAt, encodeCursor } from '../event-log-cursor';
import {
  CSV_ROW_LIMIT,
  CSV_TRAILER_PREFIX,
  EventLogExportService,
  type EventLogExportSink,
} from '../event-log-export.service';
import { toEventLogFilter } from '../event-log.filters';
import { EventLogRepository, eventLogKeysetQuery } from '../event-log.repository';
import { EventLogService } from '../event-log.service';

const connectionString = process.env.DATABASE_URL;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const FIXTURE = 'export-fixture';

interface CapturedResponse {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
  chunks: string[];
  destroyed: boolean;
  ended: boolean;
}

function capturingSink(): { sink: EventLogExportSink; captured: CapturedResponse } {
  const captured: CapturedResponse = { headers: {}, chunks: [], destroyed: false, ended: false };
  const sink: EventLogExportSink = {
    get headersSent() {
      return captured.chunks.length > 0;
    },
    get destroyed() {
      return captured.destroyed;
    },
    status: (code) => (captured.status = code),
    setHeader: (name, value) => (captured.headers[name] = value),
    json: (body) => (captured.body = body),
    write: (chunk) => {
      captured.chunks.push(chunk);
      return true;
    },
    drain: () => Promise.resolve(),
    end: () => (captured.ended = true),
    destroy: () => (captured.destroyed = true),
  };

  return { sink, captured };
}

function countingSink(): { sink: EventLogExportSink; captured: CapturedResponse; rows: () => number } {
  const { sink, captured } = capturingSink();
  let rows = 0;
  const write = sink.write;

  return {
    sink: {
      ...sink,
      get headersSent() {
        return rows > 0;
      },
      get destroyed() {
        return captured.destroyed;
      },
      write: (chunk) => {
        rows += (chunk.match(/\n/g) ?? []).length;
        if (chunk.startsWith(CSV_TRAILER_PREFIX) || chunk.startsWith('"id"')) write(chunk);
        return true;
      },
    },
    captured,
    rows: () => rows,
  };
}

describe.skipIf(!connectionString)('event-log export (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let repository: EventLogRepository;
  let browse: EventLogService;
  let exportService: EventLogExportService;
  const organizationIds: string[] = [];

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  function newOrganization(): string {
    const organizationId = randomUUID();
    organizationIds.push(organizationId);
    return organizationId;
  }

  function identity(organizationId: string, permissions: string[] = ['event-log:access']): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: { user: { id: 'u-export', email: 'export@example.com' } },
    } as unknown as IdentityContext;
  }

  const runAs = <T>(organizationId: string, fn: () => Promise<T>, permissions?: string[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run({ requestId: `req-${randomUUID()}`, identity: identity(organizationId, permissions) }, () => {
        fn().then(resolve, reject);
      });
    });

  function row(organizationId: string, createdAt: Date, overrides: Partial<Prisma.EventLogCreateManyInput> = {}) {
    return {
      organizationId,
      tier: 'ACTIVITY' as const,
      durability: 'BEST_EFFORT' as const,
      resource: FIXTURE,
      action: 'update',
      actionKey: 'fixture.update',
      actorType: 'UI' as const,
      outcome: 'SUCCEEDED' as const,
      createdAt,
      ...overrides,
    };
  }

  async function seedSpan(organizationId: string, origin: Date, count: number, stepMs: number): Promise<void> {
    const data = Array.from({ length: count }, (_, index) =>
      row(organizationId, new Date(origin.getTime() + index * stepMs)),
    );
    for (let offset = 0; offset < data.length; offset += 2_000) {
      await prisma.eventLog.createMany({ data: data.slice(offset, offset + 2_000) });
    }
  }

  const pullJson = (organizationId: string, query: Record<string, unknown>) =>
    runAs(organizationId, async () => {
      const { sink, captured } = capturingSink();
      await exportService.export({ resource: FIXTURE, ...query, format: 'json' }, sink);
      return captured;
    });

  const pullCsv = (organizationId: string, query: Record<string, unknown> = {}) =>
    runAs(organizationId, async () => {
      const { sink, captured } = capturingSink();
      await exportService.export({ resource: FIXTURE, ...query, format: 'csv' }, sink);
      return captured;
    });

  function jsonPage(captured: CapturedResponse): { data: EventLogEntry[]; cursor: string; hasMore: boolean } {
    expect(captured.status).toBe(200);
    const body = captured.body;
    if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('not an export page');
    return body as { data: EventLogEntry[]; cursor: string; hasMore: boolean };
  }

  async function drainJson(
    organizationId: string,
    query: Record<string, unknown>,
    maxPages = 40,
  ): Promise<{ ids: string[]; cursor: string }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = jsonPage(await pullJson(organizationId, { ...query, ...(cursor ? { cursor } : {}) }));
      ids.push(...result.data.map((entry) => entry.id));
      cursor = result.cursor;
      if (!result.hasMore) break;
    }
    return { ids, cursor: cursor ?? '' };
  }

  beforeAll(() => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());
    repository = new EventLogRepository(prisma);
    browse = new EventLogService(repository, logger as never, contextService);
    exportService = new EventLogExportService(
      repository,
      browse,
      contextService,
      { get: () => undefined } as never,
      logger as never,
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await prisma.$disconnect();
  }, 60_000);

  it('serves the keyset scan from an index condition on the ascending key rather than a sort', async () => {
    const organizationId = newOrganization();
    await seedSpan(organizationId, new Date(Date.now() - 3 * HOUR_MS), 20, MINUTE_MS);
    const filter = toEventLogFilter(organizationId, {});
    const query = eventLogKeysetQuery(filter, { createdAt: new Date(0), id: '' }, 100);

    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      return tx.$queryRaw<Array<Record<string, string>>>(Prisma.sql`EXPLAIN ${query}`);
    });
    const text = plan.map((line) => Object.values(line)[0]).join('\n');

    expect(text).toMatch(/Index Cond:.*ROW\("createdAt", id\) > ROW/s);
    expect(text).toMatch(/Index (Only )?Scan/);
    expect(text).not.toContain('Sort');
  });

  it('loses no row across a paged pull', async () => {
    const organizationId = newOrganization();
    const origin = new Date(Date.now() - 30 * MINUTE_MS);
    await seedSpan(organizationId, origin, 10, 1_000);
    const seeded = await prisma.eventLog.findMany({
      where: { organizationId, resource: FIXTURE },
      select: { id: true },
    });

    const { ids } = await drainJson(organizationId, { pageSize: 3 });

    expect(new Set(ids)).toEqual(new Set(seeded.map((entry) => entry.id)));
  });

  it('delivers rows in ascending key order within a page', async () => {
    const organizationId = newOrganization();
    await seedSpan(organizationId, new Date(Date.now() - 30 * MINUTE_MS), 5, 1_000);

    const page = jsonPage(await pullJson(organizationId, { pageSize: 10 }));
    const times = page.data.map((entry) => entry.createdAt.getTime());

    expect(times).toEqual([...times].sort((left, right) => left - right));
  });

  it('tolerates duplicates when a cycle restarts over its lookback window', async () => {
    const organizationId = newOrganization();
    const origin = new Date(Date.now() - 4 * HOUR_MS);
    await seedSpan(organizationId, origin, 6, 30 * MINUTE_MS);

    const first = jsonPage(await pullJson(organizationId, { from: origin.toISOString(), pageSize: 100 }));
    const highWaterMark = first.data[first.data.length - 1].createdAt;
    const second = jsonPage(
      await pullJson(organizationId, { from: origin.toISOString(), pageSize: 100, cursor: first.cursor }),
    );

    expect(first.data).toHaveLength(6);
    expect(second.data.every((entry) => first.data.some((earlier) => earlier.id === entry.id))).toBe(true);
    expect(second.data.some((entry) => entry.createdAt.getTime() < highWaterMark.getTime())).toBe(true);
  });

  it('delivers a row that committed behind a position the cursor already passed', async () => {
    const organizationId = newOrganization();
    const origin = new Date(Date.now() - 4 * HOUR_MS);
    await seedSpan(organizationId, origin, 6, 30 * MINUTE_MS);

    const first = jsonPage(await pullJson(organizationId, { from: origin.toISOString(), pageSize: 100 }));
    const highWaterMark = first.data[first.data.length - 1].createdAt;
    const late = await prisma.eventLog.create({
      data: row(organizationId, new Date(highWaterMark.getTime() - 15 * MINUTE_MS), { actionKey: 'fixture.late' }),
    });
    const second = jsonPage(
      await pullJson(organizationId, { from: origin.toISOString(), pageSize: 100, cursor: first.cursor }),
    );

    expect(late.createdAt.getTime()).toBeLessThan(highWaterMark.getTime());
    expect(first.data.map((entry) => entry.id)).not.toContain(late.id);
    expect(second.data.map((entry) => entry.id)).toContain(late.id);
  });

  it('rejects a cursor older than the retention floor with the oldest available key', async () => {
    const organizationId = newOrganization();
    await seedSpan(organizationId, new Date(Date.now() - 30 * MINUTE_MS), 3, 1_000);
    const oldest = await repository.findOldestKey(organizationId);

    const captured = await pullJson(organizationId, {
      cursor: encodeCursor(cursorAt(new Date('2019-01-01T00:00:00.000Z'))),
    });

    expect(captured.status).toBe(409);
    expect(captured.body).toMatchObject({ error: 'cursor_expired', oldestAvailable: oldest });
  });

  it('resumes from the replacement cursor a stale cursor hands back', async () => {
    const organizationId = newOrganization();
    await seedSpan(organizationId, new Date(Date.now() - 30 * MINUTE_MS), 3, 1_000);
    const expired = await pullJson(organizationId, {
      cursor: encodeCursor(cursorAt(new Date('2019-01-01T00:00:00.000Z'))),
    });
    const replacement = expired.body;
    if (!replacement || typeof replacement !== 'object' || !('cursor' in replacement)) {
      throw new Error('no replacement cursor');
    }

    const resumed = jsonPage(await pullJson(organizationId, { cursor: replacement.cursor, pageSize: 100 }));

    expect(resumed.data).toHaveLength(3);
  });

  it('reaches no other organization by any cursor, filter, or injected organization id', async () => {
    const mine = newOrganization();
    const theirs = newOrganization();
    const origin = new Date(Date.now() - 2 * HOUR_MS);
    await seedSpan(mine, origin, 5, MINUTE_MS);
    await prisma.eventLog.createMany({
      data: Array.from({ length: 5 }, (_, index) =>
        row(theirs, new Date(origin.getTime() + index * MINUTE_MS + 30_000), { actionKey: 'secret.leak' }),
      ),
    });
    const mineIds = new Set(
      (await prisma.eventLog.findMany({ where: { organizationId: mine, resource: FIXTURE } })).map((e) => e.id),
    );

    const plain = jsonPage(await pullJson(mine, { from: origin.toISOString(), pageSize: 100 }));
    const byTheirCursor = jsonPage(
      await pullJson(mine, { cursor: encodeCursor(cursorAt(origin)), pageSize: 100 }),
    );
    const byTheirFilter = jsonPage(
      await pullJson(mine, { from: origin.toISOString(), actionKey: 'secret.leak', pageSize: 100 }),
    );
    const byInjectedOrganization = jsonPage(
      await pullJson(mine, { from: origin.toISOString(), organizationId: theirs, pageSize: 100 }),
    );
    const csv = await pullCsv(mine, { organizationId: theirs });

    expect(plain.data).toHaveLength(5);
    for (const page of [plain, byTheirCursor, byTheirFilter, byInjectedOrganization]) {
      expect(page.data.every((entry) => mineIds.has(entry.id))).toBe(true);
    }
    expect(byTheirFilter.data).toHaveLength(0);
    expect(csv.chunks.join('')).not.toContain('secret.leak');
  });

  it('refuses a caller without event-log access before reading anything', async () => {
    const organizationId = newOrganization();
    await seedSpan(organizationId, new Date(Date.now() - 30 * MINUTE_MS), 2, 1_000);

    const captured = await runAs(
      organizationId,
      async () => {
        const { sink, captured: result } = capturingSink();
        await exportService.export({ format: 'json' }, sink);
        return result;
      },
      [],
    );

    expect(captured.status).toBe(403);
    expect(captured.body).toMatchObject({ statusCode: 403 });
  });

  it('answers the same filtered set as the browse route', async () => {
    const organizationId = newOrganization();
    const origin = new Date(Date.now() - 2 * HOUR_MS);
    await prisma.eventLog.createMany({
      data: [
        row(organizationId, new Date(origin.getTime() + MINUTE_MS), {
          actionKey: 'member.removed',
          tier: 'EVIDENCE',
          durability: 'ATOMIC',
          targetId: 'm-1',
        }),
        row(organizationId, new Date(origin.getTime() + 2 * MINUTE_MS), { outcome: 'DENIED' }),
        row(organizationId, new Date(origin.getTime() + 3 * MINUTE_MS), { actorType: 'SYSTEM' }),
        row(organizationId, new Date(origin.getTime() + 4 * MINUTE_MS), { actorId: 'u-9' }),
      ],
    });

    const filters: Array<Partial<EventLogQuery>> = [
      {},
      { actionKey: 'member.removed' },
      { tier: 'EVIDENCE', durability: 'ATOMIC' },
      { outcome: 'DENIED' },
      { targetId: 'm-1' },
      { actorId: 'u-9' },
      { includeSystemActors: true },
      { actorType: 'SYSTEM' },
      { from: new Date(origin.getTime() + 3 * MINUTE_MS) },
      { to: new Date(origin.getTime() + 2 * MINUTE_MS) },
    ];

    for (const filter of filters) {
      const browsed = await runAs(organizationId, () =>
        browse.list({ page: 1, pageSize: 100, resource: FIXTURE, ...filter }),
      );
      const exported = await drainJson(organizationId, {
        ...filter,
        from: (filter.from ?? origin).toISOString(),
        ...(filter.to ? { to: filter.to.toISOString() } : {}),
        pageSize: 100,
      });

      expect(new Set(exported.ids)).toEqual(new Set(browsed.data.map((entry) => entry.id)));
    }
  }, 60_000);

  it('streams a csv of the header row, every matching row, and a trailing metadata line', async () => {
    const organizationId = newOrganization();
    await seedSpan(organizationId, new Date(Date.now() - 30 * MINUTE_MS), 4, 1_000);

    const captured = await pullCsv(organizationId);
    const lines = captured.chunks.join('').trimEnd().split('\n');

    expect(captured.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(captured.headers['X-Event-Log-Truncated']).toBe('false');
    expect(lines[0].startsWith('"id","createdAt"')).toBe(true);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe(`${CSV_TRAILER_PREFIX} rows=4 truncated=false limit=${CSV_ROW_LIMIT}`);
    expect(captured.ended).toBe(true);
    expect(captured.destroyed).toBe(false);
  });

  it('reads the whole history by default rather than the cursor lookback', async () => {
    const organizationId = newOrganization();
    await seedSpan(organizationId, new Date(Date.now() - 10 * HOUR_MS), 3, HOUR_MS);

    const captured = await pullCsv(organizationId);

    expect(captured.chunks.join('').trimEnd().split('\n')).toHaveLength(5);
  });

  it('does not report exactly the row limit as truncated, but does report one more', async () => {
    const organizationId = newOrganization();
    const origin = new Date(Date.now() - 20 * HOUR_MS);
    await seedSpan(organizationId, origin, CSV_ROW_LIMIT + 1, 1);
    const boundary = new Date(origin.getTime() + CSV_ROW_LIMIT - 1);

    const exact = await runAs(organizationId, async () => {
      const { sink, captured, rows } = countingSink();
      await exportService.export({ format: 'csv', to: boundary.toISOString() }, sink);
      return { captured, rows: rows() };
    });
    const overflowing = await runAs(organizationId, async () => {
      const { sink, captured, rows } = countingSink();
      await exportService.export({ format: 'csv' }, sink);
      return { captured, rows: rows() };
    });

    expect(exact.captured.headers['X-Event-Log-Truncated']).toBe('false');
    expect(exact.rows).toBe(CSV_ROW_LIMIT + 2);
    expect(exact.captured.chunks.at(-1)).toBe(
      `${CSV_TRAILER_PREFIX} rows=${CSV_ROW_LIMIT} truncated=false limit=${CSV_ROW_LIMIT}\n`,
    );
    expect(overflowing.captured.headers['X-Event-Log-Truncated']).toBe('true');
    expect(overflowing.captured.chunks.at(-1)).toBe(
      `${CSV_TRAILER_PREFIX} rows=${CSV_ROW_LIMIT} truncated=true limit=${CSV_ROW_LIMIT}\n`,
    );
  }, 300_000);
});
