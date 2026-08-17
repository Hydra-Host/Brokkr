import { describe, expect, it } from 'vitest';
import { createTestServer, runFixture, stubApi, type StubCall } from '../testkit.js';

describe('build/layer/storage tools', () => {
  it('lab_build_agent starts the build and waits', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi(
        {
          'POST /api/build/agent': { status: 200, body: { runId: 'r1' } },
          'GET /api/runs/r1': { status: 200, body: runFixture({ section: 'build', status: 'passed' }) },
        },
        calls,
      ),
    );
    const result = await client.callTool({ name: 'lab_build_agent', arguments: { wait: true } });
    expect(calls[0]?.method).toBe('POST');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('"status":"passed"');
  });

  it('lab_seed_layers posts the manifest url', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'POST /api/layers/seed': { status: 200, body: { runId: 'r2' } } }, calls),
    );
    await client.callTool({
      name: 'lab_seed_layers',
      arguments: { url: 'https://assets.example.com/os-layers/releases/v1', wait: false },
    });
    expect(calls[0]?.body).toEqual({ url: 'https://assets.example.com/os-layers/releases/v1' });
  });

  it('lab_verify_storage returns the verification report', async () => {
    const body = { files: [{ name: 'brokkr-live-amd64.img', status: 'match' }] };
    const { client } = await createTestServer(stubApi({ 'POST /api/storage/verify': { status: 200, body } }));
    const result = await client.callTool({ name: 'lab_verify_storage', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('hides wipe and nuke unless destructive is allowed', async () => {
    const off = await createTestServer(stubApi({}));
    const offNames = (await off.client.listTools()).tools.map((t) => t.name);
    expect(offNames).not.toContain('lab_wipe_storage');
    expect(offNames).not.toContain('lab_nuke_layer_blob');
    const on = await createTestServer(stubApi({}), { allowDestructive: true });
    const onNames = (await on.client.listTools()).tools.map((t) => t.name);
    expect(onNames).toContain('lab_wipe_storage');
    expect(onNames).toContain('lab_nuke_layer_blob');
  });
});
