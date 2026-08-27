import { describe, expect, it } from 'vitest';
import { createTestServer, stubApi, type StubCall } from '../testkit.js';

describe('status tools', () => {
  it('registers the status toolset', async () => {
    const { client } = await createTestServer(stubApi({}));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'lab_get_audit_log',
        'lab_get_branches',
        'lab_get_stack_config',
        'lab_get_stack_state',
        'lab_get_status',
        'lab_list_app_links',
        'lab_list_services',
        'lab_list_stack_ops',
        'lab_list_stacks',
      ]),
    );
  });

  it('lab_get_status returns the api body with the serving slot merged in', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/status': { status: 200, body: { version: '1.2.3' } },
        'GET /api/stacks': { status: 200, body: { stacks: [], selfSlot: 3 } },
      }),
    );
    const result = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(JSON.parse(String(result.content[0]?.text))).toEqual({
      version: '1.2.3',
      selfSlot: 3,
      labTarget: { slot: null, checkout: null, source: 'explicit', own: true },
    });
  });

  it('lab_get_status reports selfSlot as null when the loopback-only stacks route refuses', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/status': { status: 200, body: { version: '1.2.3' } },
        'GET /api/stacks': { status: 403, body: { message: 'this lab route is loopback-only' } },
      }),
    );
    const result = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content[0]?.text))).toEqual({
      version: '1.2.3',
      selfSlot: null,
      labTarget: { slot: null, checkout: null, source: 'explicit', own: true },
    });
  });

  it('lab_get_status surfaces a server error from the stacks route instead of nulling selfSlot', async () => {
    const { client } = await createTestServer(
      stubApi({
        'GET /api/status': { status: 200, body: { version: '1.2.3' } },
        'GET /api/stacks': { status: 500, body: { error: 'registry unreadable' } },
      }),
    );
    const result = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('listStacks: registry unreadable');
  });

  it('lab_list_stacks returns the host stack listing', async () => {
    const body = { stacks: [{ slot: 1, checkout: '/repo', live: true }], selfSlot: 1 };
    const { client } = await createTestServer(stubApi({ 'GET /api/stacks': { status: 200, body } }));
    const result = await client.callTool({ name: 'lab_list_stacks', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('maps api errors to isError results', async () => {
    const { client } = await createTestServer(stubApi({ 'GET /api/status': { status: 500, body: { error: 'boom' } } }));
    const result = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('getStatus: boom');
  });

  it('lab_get_audit_log forwards filters as query params', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(stubApi({ 'GET /api/audit': { status: 200, body: [] } }, calls));
    await client.callTool({ name: 'lab_get_audit_log', arguments: { method: 'POST', limit: 5 } });
    expect(calls[0]?.path).toContain('/api/audit?');
    expect(calls[0]?.path).toContain('method=POST');
    expect(calls[0]?.path).toContain('limit=5');
  });
});
