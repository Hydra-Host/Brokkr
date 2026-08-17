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
      ]),
    );
  });

  it('lab_get_status returns the api body as json text', async () => {
    const body = { version: '1.2.3' };
    const { client } = await createTestServer(stubApi({ 'GET /api/status': { status: 200, body } }));
    const result = await client.callTool({ name: 'lab_get_status', arguments: {} });
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
