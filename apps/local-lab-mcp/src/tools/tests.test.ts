import { describe, expect, it } from 'vitest';
import { createTestServer, runFixture, stubApi, type StubCall } from '../testkit.js';

const CATALOG = [
  { id: 'smoke', label: 'Smoke', description: 'd', pinNode: false, destructive: false },
  { id: 'lifecycle-full', label: 'Lifecycle', description: 'd', pinNode: true, destructive: true },
];

describe('test-scenario tools', () => {
  it('lab_list_test_scenarios returns the catalog', async () => {
    const body = [{ id: 'smoke', label: 'Smoke' }];
    const { client } = await createTestServer(stubApi({ 'GET /api/tests': { status: 200, body } }));
    const result = await client.callTool({ name: 'lab_list_test_scenarios', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('lab_run_test launches, waits, and returns result + events + logs', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'GET /api/tests': { status: 200, body: CATALOG },
          'POST /api/tests/runs': { status: 200, body: { runId: 'r1' } },
          'GET /api/runs/r1': { status: 200, body: runFixture({ section: 'test', status: 'passed' }) },
          'GET /api/tests/runs/r1/result': { status: 200, body: { summary: { passed: 3 }, tests: [], runLogs: {} } },
          'GET /api/tests/runs/r1/events': { status: 200, body: [{ kind: 'step', label: 'pxe boot' }] },
        },
        calls,
      ),
      { sseByPath: { '/api/runs/r1/stream': 'data: {"line":"vitest ok"}\n\ndata: {"done":true}\n\n' } },
    );
    const result = await client.callTool({
      name: 'lab_run_test',
      arguments: { scenarioId: 'smoke', nodeIndex: 0, wait: true },
    });
    expect(calls[1]?.body).toMatchObject({ scenarioId: 'smoke', nodeIndex: 0 });
    const text = String(result.content[0]?.text);
    expect(text).toContain('"passed":3');
    expect(text).toContain('pxe boot');
    expect(text).toContain('vitest ok');
  });

  it('lab_run_test tolerates a missing structured result', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/tests': { status: 200, body: CATALOG },
        'POST /api/tests/runs': { status: 200, body: { runId: 'r1' } },
        'GET /api/runs/r1': { status: 200, body: runFixture({ section: 'test', status: 'failed' }) },
        'GET /api/tests/runs/r1/result': { status: 404, body: { error: 'unknown run' } },
        'GET /api/tests/runs/r1/events': { status: 200, body: [] },
      }),
    );
    const result = await client.callTool({
      name: 'lab_run_test',
      arguments: { scenarioId: 'smoke', wait: true },
    });
    expect(result.isError).toBeUndefined();
    expect(String(result.content[0]?.text)).toContain('"result":null');
  });

  it('lab_run_test surfaces a server error from the result fetch instead of mapping it to null', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/tests': { status: 200, body: CATALOG },
        'POST /api/tests/runs': { status: 200, body: { runId: 'r1' } },
        'GET /api/runs/r1': { status: 200, body: runFixture({ section: 'test', status: 'passed' }) },
        'GET /api/tests/runs/r1/result': { status: 500, body: { error: 'db exploded' } },
      }),
    );
    const result = await client.callTool({
      name: 'lab_run_test',
      arguments: { scenarioId: 'smoke', wait: true },
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('getTestResult: db exploded');
  });

  it('lab_run_test with wait=false returns just the runId', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/tests': { status: 200, body: CATALOG },
        'POST /api/tests/runs': { status: 200, body: { runId: 'r7' } },
      }),
    );
    const result = await client.callTool({ name: 'lab_run_test', arguments: { scenarioId: 'smoke', wait: false } });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r7"}' }]);
  });

  it('lab_run_test refuses a destructive scenario without the destructive flag', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(stubApi({ 'GET /api/tests': { status: 200, body: CATALOG } }, calls));
    const result = await client.callTool({
      name: 'lab_run_test',
      arguments: { scenarioId: 'lifecycle-full', wait: false },
    });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain("test scenario 'lifecycle-full' is destructive");
    expect(text).toContain('LAB_MCP_ALLOW_DESTRUCTIVE=1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET http://lab.test/api/tests']);
  });

  it('lab_run_test launches a destructive scenario when the flag is set', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/tests': { status: 200, body: CATALOG },
        'POST /api/tests/runs': { status: 200, body: { runId: 'r8' } },
      }),
      { allowDestructive: true },
    );
    const result = await client.callTool({
      name: 'lab_run_test',
      arguments: { scenarioId: 'lifecycle-full', wait: false },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r8"}' }]);
  });

  it('lab_run_test surfaces the server error for an unknown scenario id instead of refusing it', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/tests': { status: 200, body: CATALOG },
        'POST /api/tests/runs': { status: 404, body: { error: 'unknown scenario' } },
      }),
    );
    const result = await client.callTool({
      name: 'lab_run_test',
      arguments: { scenarioId: 'no-such-scenario', wait: false },
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('startTest: unknown scenario');
  });
});
