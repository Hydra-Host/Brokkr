import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebhookDeliveriesReaderService } from '../webhook-deliveries.reader';

const NOW = new Date('2026-01-02T03:04:05.000Z');

const sqlRow = (over: Record<string, unknown> = {}) => ({
  id: 'del-1',
  webhookId: 'wh-1',
  endpoint: 'https://example.test/hook',
  eventType: 'DEPLOYMENT_INTERRUPTED',
  status: 'RETRYING',
  httpStatus: 500,
  attempts: 2,
  errorMessage: 'upstream 500',
  idempotencyKey: null,
  nextRetryAt: NOW,
  createdAt: NOW,
  deliveredAt: null,
  processingLockedBy: 'worker-1',
  processingLockedAt: NOW,
  processingLockExpires: NOW,
  payload: { deploymentId: 'dep-1' },
  responseBody: 'upstream said no',
  ...over,
});

let rows: Record<string, unknown>[];
let error: Error | null;

function makePg() {
  return {
    readTyped: vi.fn(
      (
        _sql: string,
        _params: unknown[],
        schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
      ) => {
        if (error) return Promise.reject(error);
        const parsed: unknown[] = [];
        let skipped = 0;
        for (const raw of rows) {
          const result = schema.safeParse(raw);
          if (result.success) parsed.push(result.data);
          else skipped += 1;
        }
        return Promise.resolve({ rows: parsed, skipped });
      },
    ),
  };
}

let pg: ReturnType<typeof makePg>;
const makeReader = () => new WebhookDeliveriesReaderService(pg as never);
const query = { status: null, webhookId: null, limit: 50, offset: 0 };

beforeEach(() => {
  rows = [sqlRow()];
  error = null;
  pg = makePg();
});

describe('WebhookDeliveriesReaderService', () => {
  it('keeps the processing-lock columns, which the hub api never returns', async () => {
    const page = await makeReader().list(query);

    expect(page.rows[0]).toMatchObject({ lockedBy: 'worker-1' });
    expect(page.rows[0].lockedAtMs).toBe(NOW.getTime());
    expect(page.rows[0].lockExpiresAtMs).toBe(NOW.getTime());
  });

  it('joins the endpoint but carries no signing secret', async () => {
    const page = await makeReader().list(query);

    expect(page.rows[0].endpoint).toBe('https://example.test/hook');
    expect(page.rows[0]).not.toHaveProperty('secret');
  });

  it('redacts a credential riding inside the event payload', async () => {
    rows = [sqlRow({ payload: { callbackUrl: 'https://user:hunter2@example.test/cb', deploymentId: 'dep-1' } })];

    const page = await makeReader().list(query);

    expect(JSON.stringify(page.rows[0].payload)).not.toContain('hunter2');
    expect(JSON.stringify(page.rows[0].payload)).toContain('dep-1');
  });

  it(
    'caps a very large response body and says so, rather than passing a prefix off as the whole',
    { timeout: 20_000 },
    async () => {
      rows = [sqlRow({ responseBody: 'x'.repeat(50_000) })];

      const page = await makeReader().list(query);

      expect(page.rows[0].responseBody?.length).toBeLessThan(50_000);
      expect(page.rows[0].responseBodyTruncated).toBe(true);
    },
  );

  it('leaves a short response body unflagged, so the flag stays a measurement', async () => {
    const page = await makeReader().list(query);

    expect(page.rows[0].responseBody).toBe('upstream said no');
    expect(page.rows[0].responseBodyTruncated).toBe(false);
  });

  it('redacts a credential the endpoint echoed back in its response body', async () => {
    rows = [sqlRow({ responseBody: 'rejected callback https://user:hunter2@example.test/cb' })];

    const page = await makeReader().list(query);

    expect(page.rows[0].responseBody).not.toContain('hunter2');
    expect(page.rows[0].responseBody).toContain('example.test/cb');
  });

  it('redacts basic-auth userinfo carried in the endpoint url itself', async () => {
    rows = [sqlRow({ endpoint: 'https://svc:s3cr3t@example.test/hook' })];

    const page = await makeReader().list(query);

    expect(page.rows[0].endpoint).not.toContain('s3cr3t');
    expect(page.rows[0].endpoint).toContain('example.test/hook');
  });

  it('redacts a credential the hub recorded in the failure text', async () => {
    rows = [sqlRow({ errorMessage: 'connect failed for https://user:hunter2@example.test/hook' })];

    const page = await makeReader().list(query);

    expect(page.rows[0].errorMessage).not.toContain('hunter2');
    expect(page.rows[0].errorMessage).toContain('connect failed');
  });

  it('keeps a delivery that never got a response distinct from one that returned zero', async () => {
    rows = [sqlRow({ httpStatus: null }), sqlRow({ id: 'del-2', httpStatus: 0 })];

    const page = await makeReader().list(query);

    expect(page.rows[0].httpStatus).toBeNull();
    expect(page.rows[1].httpStatus).toBe(0);
  });

  it('reports an empty list as unknown rather than none when the read fails', async () => {
    error = new Error('pg down');

    const page = await makeReader().list(query);

    expect(page.rows).toEqual([]);
    expect(page.readError).toContain('pg down');
  });

  it('binds the status filter rather than receiving it pre-interpolated', async () => {
    await makeReader().list({ status: 'FAILED', webhookId: 'wh-9', limit: 10, offset: 20 });

    const [sql, params] = pg.readTyped.mock.calls[0];
    expect(params).toEqual(['FAILED', 'wh-9', 10, 20]);
    expect(sql).not.toContain('FAILED');
  });

  it('counts a row it cannot parse rather than shortening the list silently', async () => {
    rows = [sqlRow(), sqlRow({ id: '' })];

    const page = await makeReader().list(query);

    expect(page.rows).toHaveLength(1);
    expect(page.skipped).toBe(1);
  });
});
