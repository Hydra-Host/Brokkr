import { describe, expect, it } from 'vitest';
import { createTestServer, runFixture, stubApi, type StubCall } from '../testkit.js';

describe('run-ledger tools', () => {
  it('lab_list_runs forwards filters as query params', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(stubApi({ 'GET /api/runs': { status: 200, body: [] } }, calls));
    await client.callTool({ name: 'lab_list_runs', arguments: { section: 'fleet', status: 'running', limit: 5 } });
    expect(calls[0]?.path).toContain('section=fleet');
    expect(calls[0]?.path).toContain('status=running');
    expect(calls[0]?.path).toContain('limit=5');
  });

  it('lab_get_run returns one run', async () => {
    const { client } = await createTestServer(
      stubApi({ 'GET /api/runs/r1': { status: 200, body: runFixture({ status: 'failed' }) } }),
    );
    const result = await client.callTool({ name: 'lab_get_run', arguments: { runId: 'r1' } });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('"status":"failed"');
  });

  it('lab_get_run_logs collects the sse stream', async () => {
    const { client } = await createTestServer(stubApi({}), {
      sseByPath: { '/api/runs/r1/stream': 'data: {"line":"line-one"}\n\ndata: {"done":true}\n\n' },
    });
    const result = await client.callTool({ name: 'lab_get_run_logs', arguments: { runId: 'r1' } });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('line-one');
    expect(text).toContain('"done":true');
  });

  it('lab_cancel_run posts to the cancel route', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'POST /api/runs/r1/cancel': { status: 200, body: { cancelled: true } } }, calls),
    );
    const result = await client.callTool({ name: 'lab_cancel_run', arguments: { runId: 'r1' } });
    expect(calls[0]?.method).toBe('POST');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('"cancelled":true');
  });
});
