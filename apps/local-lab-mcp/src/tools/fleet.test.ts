import { describe, expect, it } from 'vitest';
import { createTestServer, runFixture, stubApi, type StubCall } from '../testkit.js';

describe('fleet tools', () => {
  it('lab_list_fleet_machines returns the roster', async () => {
    const body = [{ name: 'cpu-1', power: 'on' }];
    const { client } = await createTestServer(stubApi({ 'GET /api/fleet/machines': { status: 200, body } }));
    const result = await client.callTool({ name: 'lab_list_fleet_machines', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('lab_fleet_power posts the action and waits', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'POST /api/fleet/machines/power': { status: 200, body: { runId: 'r1' } },
          'GET /api/runs/r1': { status: 200, body: runFixture({ status: 'passed' }) },
        },
        calls,
      ),
      { sseByPath: { '/api/runs/r1/stream': 'data: {"line":"cycled"}\n\ndata: {"done":true}\n\n' } },
    );
    const result = await client.callTool({
      name: 'lab_fleet_power',
      arguments: { name: 'cpu-1', action: 'cycle', wait: true },
    });
    expect(calls[0]?.body).toEqual({ name: 'cpu-1', action: 'cycle' });
    expect(result.isError).toBeUndefined();
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('"status":"passed"');
    expect(text).toContain('cycled');
  });

  it('lab_fleet_exec returns stdout/stderr/exit', async () => {
    const body = { stdout: 'up 2 days', stderr: '', exitCode: 0 };
    const { client } = await createTestServer(stubApi({ 'POST /api/fleet/machines/exec': { status: 200, body } }));
    const result = await client.callTool({
      name: 'lab_fleet_exec',
      arguments: { name: 'cpu-1', command: 'uptime' },
    });
    expect(JSON.stringify(result.content)).toContain('up 2 days');
  });

  it('lab_fleet_console_log forwards tail_bytes', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'GET /api/fleet/machines/cpu-1/console-log': { status: 200, body: { log: 'boot' } } }, calls),
    );
    await client.callTool({ name: 'lab_fleet_console_log', arguments: { name: 'cpu-1', tailBytes: 4096 } });
    expect(calls[0]?.path).toContain('tail_bytes=4096');
  });

  it('hides lab_fleet_reset unless destructive is allowed', async () => {
    const off = await createTestServer(stubApi({}));
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain('lab_fleet_reset');
    const on = await createTestServer(stubApi({}), { allowDestructive: true });
    expect((await on.client.listTools()).tools.map((t) => t.name)).toContain('lab_fleet_reset');
  });
});
