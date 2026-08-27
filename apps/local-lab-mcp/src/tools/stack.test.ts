import { describe, expect, it } from 'vitest';
import { createTestServer, runFixture, stubApi, type StubCall } from '../testkit.js';

const OPS = [
  {
    id: 'reconcile',
    label: 'Reconcile',
    task: 't',
    description: 'd',
    section: 'stack',
    group: 'status',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'up',
    label: 'Up',
    task: 't',
    description: 'd',
    section: 'stack',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'nuke',
    label: 'Nuke',
    task: 't',
    description: 'd',
    section: 'stack',
    group: 'destructive',
    destructive: true,
    needsSudo: false,
  },
];

describe('stack tools', () => {
  it('hides destructive tools unless allowed', async () => {
    const { client } = await createTestServer(stubApi({}));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('lab_run_stack_op');
    expect(names).not.toContain('lab_update_stack_config');
    expect(names).not.toContain('lab_checkout_branch');
  });

  it('registers destructive tools when allowed', async () => {
    const { client } = await createTestServer(stubApi({}), { allowDestructive: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('lab_update_stack_config');
    expect(names).toContain('lab_checkout_branch');
  });

  it('lab_run_stack_op posts the op and waits for completion', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'GET /api/stack/ops': { status: 200, body: OPS },
          'POST /api/stack/runs': { status: 200, body: { runId: 'r1' } },
          'GET /api/runs/r1': { status: 200, body: runFixture({ status: 'passed', exitCode: 0 }) },
        },
        calls,
      ),
      { sseByPath: { '/api/runs/r1/stream': 'data: {"line":"ok"}\n\ndata: {"done":true}\n\n' } },
    );
    const result = await client.callTool({
      name: 'lab_run_stack_op',
      arguments: { opId: 'reconcile', wait: true },
    });
    expect(calls[1]?.body).toEqual({ opId: 'reconcile', allowDataLoss: undefined, force: undefined });
    expect(result.isError).toBeUndefined();
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('"status":"passed"');
    expect(text).toContain('ok');
  });

  it('lab_run_stack_op returns the runId without waiting when wait is false', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/stack/ops': { status: 200, body: OPS },
        'POST /api/stack/runs': { status: 200, body: { runId: 'r2' } },
      }),
    );
    const result = await client.callTool({
      name: 'lab_run_stack_op',
      arguments: { opId: 'up', wait: false },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r2"}' }]);
  });

  it('lab_run_stack_op surfaces a 409 lane conflict as an error result', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/stack/ops': { status: 200, body: OPS },
        'POST /api/stack/runs': { status: 409, body: { error: 'op already running' } },
      }),
    );
    const result = await client.callTool({
      name: 'lab_run_stack_op',
      arguments: { opId: 'up', wait: false },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('startStackRun: op already running');
  });

  it('lab_run_stack_op refuses a destructive op without the destructive flag', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(stubApi({ 'GET /api/stack/ops': { status: 200, body: OPS } }, calls));
    const result = await client.callTool({
      name: 'lab_run_stack_op',
      arguments: { opId: 'nuke', wait: false },
    });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain("stack op 'nuke' is destructive");
    expect(text).toContain('LAB_MCP_ALLOW_DESTRUCTIVE=1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET http://lab.test/api/stack/ops']);
  });

  it('lab_run_stack_op launches a destructive op when the flag is set', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/stack/ops': { status: 200, body: OPS },
        'POST /api/stack/runs': { status: 200, body: { runId: 'r3' } },
      }),
      { allowDestructive: true },
    );
    const result = await client.callTool({
      name: 'lab_run_stack_op',
      arguments: { opId: 'nuke', wait: false },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r3"}' }]);
  });

  it('lab_redeploy_stack refuses when the staged slot differs from the serving slot', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'GET /api/stack/config': { status: 200, body: { seeded: true, slot: 2, values: { hub: {}, spoke: {} } } },
          'GET /api/stacks': { status: 200, body: { stacks: [], selfSlot: 0 } },
        },
        calls,
      ),
    );
    const result = await client.callTool({ name: 'lab_redeploy_stack', arguments: { wait: false } });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('slot 0 to slot 2');
    expect(text).toContain('LAB_MCP_ALLOW_DESTRUCTIVE=1');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
  });

  it('lab_redeploy_stack refuses when the stack config eval is unseeded', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/stack/config': { status: 200, body: { seeded: false, slot: 0, values: { hub: {}, spoke: {} } } },
        'GET /api/stacks': { status: 200, body: { stacks: [], selfSlot: 0 } },
      }),
    );
    const result = await client.callTool({ name: 'lab_redeploy_stack', arguments: { wait: false } });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('unseeded');
    expect(text).toContain('LAB_MCP_ALLOW_DESTRUCTIVE=1');
  });

  it('lab_redeploy_stack runs when the staged slot matches the serving slot', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/stack/config': { status: 200, body: { seeded: true, slot: 3, values: { hub: {}, spoke: {} } } },
        'GET /api/stacks': { status: 200, body: { stacks: [], selfSlot: 3 } },
        'POST /api/stack/redeploy': { status: 200, body: { runId: 'r4' } },
      }),
    );
    const result = await client.callTool({ name: 'lab_redeploy_stack', arguments: { wait: false } });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r4"}' }]);
  });

  it('lab_redeploy_stack skips the slot pre-flight when the destructive flag is set', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'POST /api/stack/redeploy': { status: 200, body: { runId: 'r5' } } }, calls),
      { allowDestructive: true },
    );
    const result = await client.callTool({ name: 'lab_redeploy_stack', arguments: { wait: false } });
    expect(result.content).toEqual([{ type: 'text', text: '{"runId":"r5"}' }]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST http://lab.test/api/stack/redeploy']);
  });

  it('lab_control_service posts the action', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'POST /api/services/control': { status: 200, body: { ok: true } } }, calls),
    );
    await client.callTool({ name: 'lab_control_service', arguments: { id: 'hub-api', action: 'restart' } });
    expect(calls[0]?.body).toEqual({ id: 'hub-api', action: 'restart' });
  });

  it('lab_update_stack_config sends the paths it was given and reads nothing first', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'PUT /api/stack/config': { status: 200, body: { ok: true, applied: ['telemetry.enable'], rejected: [] } },
        },
        calls,
      ),
      { allowDestructive: true },
    );
    const result = await client.callTool({
      name: 'lab_update_stack_config',
      arguments: { entries: { 'telemetry.enable': 'true' } },
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toEqual({ entries: { 'telemetry.enable': 'true' } });
  });

  it('lab_update_stack_config passes a null through as the revert verb', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'PUT /api/stack/config': { status: 200, body: { ok: true, applied: [], rejected: [] } } }, calls),
      { allowDestructive: true },
    );
    await client.callTool({
      name: 'lab_update_stack_config',
      arguments: { entries: { 'ports.postgres': null } },
    });
    expect(calls[0]?.body).toEqual({ entries: { 'ports.postgres': null } });
  });

  it('lab_update_stack_config omits the slot entirely when none was asked for', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'PUT /api/stack/config': { status: 200, body: { ok: true, applied: [], rejected: [] } } }, calls),
      { allowDestructive: true },
    );
    await client.callTool({ name: 'lab_update_stack_config', arguments: { entries: {} } });
    expect(Object.hasOwn(calls[0]?.body as object, 'slot')).toBe(false);
  });
});

it('lab_update_stack_config forwards a slot when one is given', async () => {
  const calls: StubCall[] = [];
  const { client } = await createTestServer(
    stubApi({ 'PUT /api/stack/config': { status: 200, body: { ok: true, applied: [], rejected: [] } } }, calls),
    { allowDestructive: true },
  );
  await client.callTool({ name: 'lab_update_stack_config', arguments: { entries: {}, slot: 3 } });
  expect(calls[0]?.body).toEqual({ entries: {}, slot: 3 });
});
