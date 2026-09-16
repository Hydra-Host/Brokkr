import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestServer, runFixture, stubApi, type StubCall } from '../testkit.js';

const ROSTER = [
  { name: 'cpu-1', kind: 'vm', power: 'on', configured: true, deviceId: null, bmc: null },
  { name: 'rack-7', kind: 'baremetal', power: 'on', configured: true, deviceId: null, bmc: null },
];

const powerCalls = (calls: StubCall[]): StubCall[] => calls.filter((c) => c.path.endsWith('/api/fleet/machines/power'));

describe('fleet tools', () => {
  afterEach(() => vi.unstubAllEnvs());

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
          'GET /api/fleet/machines': { status: 200, body: ROSTER },
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
    expect(powerCalls(calls).map((c) => c.body)).toEqual([{ name: 'cpu-1', action: 'cycle' }]);
    expect(result.isError).toBeUndefined();
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('"status":"passed"');
    expect(text).toContain('cycled');
  });

  it('lab_fleet_power powers a vm row without the destructive flag', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'GET /api/fleet/machines': { status: 200, body: ROSTER },
          'POST /api/fleet/machines/power': { status: 200, body: { runId: 'r2' } },
        },
        calls,
      ),
    );
    const result = await client.callTool({
      name: 'lab_fleet_power',
      arguments: { name: 'cpu-1', action: 'off', wait: false },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r2"}' }]);
    expect(powerCalls(calls).map((c) => c.body)).toEqual([{ name: 'cpu-1', action: 'off' }]);
  });

  it('lab_fleet_power refuses a bare-metal row without the destructive flag', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'GET /api/fleet/machines': { status: 200, body: ROSTER },
          'POST /api/fleet/machines/power': { status: 200, body: { runId: 'r3' } },
        },
        calls,
      ),
    );
    const result = await client.callTool({
      name: 'lab_fleet_power',
      arguments: { name: 'rack-7', action: 'cycle', wait: false },
    });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain("bare-metal power on 'rack-7' is destructive");
    expect(text).toContain('LAB_MCP_ALLOW_DESTRUCTIVE=1');
    expect(powerCalls(calls)).toEqual([]);
  });

  it('lab_fleet_power powers a bare-metal row when the destructive flag is set', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'GET /api/fleet/machines': { status: 200, body: ROSTER },
          'POST /api/fleet/machines/power': { status: 200, body: { runId: 'r4' } },
        },
        calls,
      ),
      { allowDestructive: true },
    );
    const result = await client.callTool({
      name: 'lab_fleet_power',
      arguments: { name: 'rack-7', action: 'cycle', wait: false },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r4"}' }]);
    expect(powerCalls(calls).map((c) => c.body)).toEqual([{ name: 'rack-7', action: 'cycle' }]);
  });

  it('lab_fleet_power surfaces the server error for an unknown name instead of refusing it', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/fleet/machines': { status: 200, body: ROSTER },
        'POST /api/fleet/machines/power': { status: 404, body: { error: "unknown machine 'ghost'" } },
      }),
    );
    const result = await client.callTool({
      name: 'lab_fleet_power',
      arguments: { name: 'ghost', action: 'on', wait: false },
    });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toBe("powerMachine: unknown machine 'ghost'");
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

  it('lab_fleet_exec presents the host token, not the api token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-tok');
    vi.stubEnv('LAB_HOST_TOKEN', 'host-tok');
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        { 'POST /api/fleet/machines/exec': { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } } },
        calls,
      ),
    );

    await client.callTool({ name: 'lab_fleet_exec', arguments: { name: 'cpu-1', command: 'uptime' } });

    expect(calls[0]?.headers['x-lab-token']).toBe('host-tok');
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
