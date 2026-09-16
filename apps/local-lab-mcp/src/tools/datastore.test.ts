import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestServer, stubApi, type StubCall } from '../testkit.js';

describe('datastore tools', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lab_pg_query posts the sql', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'POST /api/datastore/pg/query': { status: 200, body: { columns: ['n'], rows: [[1]] } } }, calls),
    );
    await client.callTool({ name: 'lab_pg_query', arguments: { sql: 'SELECT 1 AS n' } });
    expect(calls[0]?.body).toEqual({ sql: 'SELECT 1 AS n' });
  });

  it('lab_pg_query presents the host token, not the api token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-tok');
    vi.stubEnv('LAB_HOST_TOKEN', 'host-tok');
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'POST /api/datastore/pg/query': { status: 200, body: { columns: ['n'], rows: [[1]] } } }, calls),
    );

    await client.callTool({ name: 'lab_pg_query', arguments: { sql: 'SELECT 1 AS n' } });

    expect(calls[0]?.headers['x-lab-token']).toBe('host-tok');
  });

  it('lab_pg_table_rows presents the api token, not the host token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-tok');
    vi.stubEnv('LAB_HOST_TOKEN', 'host-tok');
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'GET /api/datastore/pg/tables/public/Server/rows': { status: 200, body: { rows: [] } } }, calls),
    );

    await client.callTool({ name: 'lab_pg_table_rows', arguments: { schema: 'public', table: 'Server' } });

    expect(calls[0]?.headers['x-lab-token']).toBe('api-tok');
  });

  it('lab_pg_table_rows uses schema/table path params and query pagination', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'GET /api/datastore/pg/tables/public/Server/rows': { status: 200, body: { rows: [] } } }, calls),
    );
    await client.callTool({
      name: 'lab_pg_table_rows',
      arguments: { schema: 'public', table: 'Server', limit: 10, orderBy: 'createdAt', orderDir: 'desc' },
    });
    expect(calls[0]?.path).toContain('/api/datastore/pg/tables/public/Server/rows?');
    expect(calls[0]?.path).toContain('limit=10');
    expect(calls[0]?.path).toContain('orderDir=desc');
  });

  it('lab_redis_scan forwards cursor and match', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'GET /api/datastore/redis/keys': { status: 200, body: { cursor: '0', keys: [] } } }, calls),
    );
    await client.callTool({ name: 'lab_redis_scan', arguments: { cursor: '17', match: '*:device:*' } });
    expect(calls[0]?.path).toContain('match=*%3Adevice%3A*');
    expect(calls[0]?.path).toContain('cursor=17');
  });

  it('lab_list_queue_jobs joins the states array into the comma-separated query', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'GET /api/queues/results/inbox/jobs': { status: 200, body: { jobs: [] } } }, calls),
    );
    await client.callTool({
      name: 'lab_list_queue_jobs',
      arguments: { prefix: 'results', name: 'inbox', states: ['failed', 'completed'] },
    });
    expect(calls[0]?.path).toContain('states=failed%2Ccompleted');
  });

  it('lab_retry_queue_job posts params and body', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        { 'POST /api/queues/results/inbox/jobs/j1/retry': { status: 200, body: { ok: true, runId: 'r3' } } },
        calls,
      ),
    );
    await client.callTool({
      name: 'lab_retry_queue_job',
      arguments: { prefix: 'results', name: 'inbox', jobId: 'j1', resetAttempts: true },
    });
    expect(calls[0]?.body).toEqual({ state: 'failed', resetAttempts: true });
  });

  it('hides queue mutation tools unless destructive is allowed', async () => {
    const off = await createTestServer(stubApi({}));
    const offNames = (await off.client.listTools()).tools.map((t) => t.name);
    expect(offNames).not.toContain('lab_drain_queue');
    expect(offNames).not.toContain('lab_clean_queue');
    expect(offNames).not.toContain('lab_remove_queue_job');
    const on = await createTestServer(stubApi({}), { allowDestructive: true });
    const onNames = (await on.client.listTools()).tools.map((t) => t.name);
    expect(onNames).toContain('lab_drain_queue');
    expect(onNames).toContain('lab_clean_queue');
    expect(onNames).toContain('lab_remove_queue_job');
  });
});
