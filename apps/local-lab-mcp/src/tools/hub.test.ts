import { describe, expect, it } from 'vitest';
import { createTestServer, stubApi, type StubCall } from '../testkit.js';

describe('hub debug tools', () => {
  it('lab_list_lifecycle_jobs joins phases and forwards deviceId', async () => {
    const calls: StubCall[] = [];
    const body = { jobs: [], census: { RUNNING: 2 } };
    const { client } = await createTestServer(stubApi({ 'GET /api/hub/lifecycle-jobs': { status: 200, body } }, calls));
    const result = await client.callTool({
      name: 'lab_list_lifecycle_jobs',
      arguments: { phases: ['RUNNING', 'AWAITING_PHONE_HOME'], deviceId: crypto.randomUUID() },
    });
    expect(calls[0]?.path).toContain('phases=RUNNING%2CAWAITING_PHONE_HOME');
    expect(calls[0]?.path).toContain('deviceId=');
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('lab_get_lifecycle_job fetches by id', async () => {
    const body = { job: { id: 'j9' }, timeline: [] };
    const { client } = await createTestServer(stubApi({ 'GET /api/hub/lifecycle-jobs/j9': { status: 200, body } }));
    const result = await client.callTool({ name: 'lab_get_lifecycle_job', arguments: { jobId: 'j9' } });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('lab_get_lifecycle_job_queue_jobs fetches by job id', async () => {
    const body = { joinable: false, jobs: [] };
    const { client } = await createTestServer(
      stubApi({ 'GET /api/hub/lifecycle-jobs/j9/queue-jobs': { status: 200, body } }),
    );
    const result = await client.callTool({ name: 'lab_get_lifecycle_job_queue_jobs', arguments: { jobId: 'j9' } });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('lab_list_webhook_deliveries forwards status and webhookId', async () => {
    const calls: StubCall[] = [];
    const body = { deliveries: [] };
    const { client } = await createTestServer(
      stubApi({ 'GET /api/hub/webhook-deliveries': { status: 200, body } }, calls),
    );
    const result = await client.callTool({
      name: 'lab_list_webhook_deliveries',
      arguments: { status: 'FAILED', webhookId: 'wh-1', limit: 10 },
    });
    expect(calls[0]?.path).toContain('status=FAILED');
    expect(calls[0]?.path).toContain('webhookId=wh-1');
    expect(calls[0]?.path).toContain('limit=10');
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('lab_list_device_tokens forwards deviceId and status', async () => {
    const calls: StubCall[] = [];
    const body = { tokens: [] };
    const { client } = await createTestServer(stubApi({ 'GET /api/hub/device-tokens': { status: 200, body } }, calls));
    const result = await client.callTool({
      name: 'lab_list_device_tokens',
      arguments: { deviceId: 'd1', status: 'ACTIVE' },
    });
    expect(calls[0]?.path).toContain('deviceId=d1');
    expect(calls[0]?.path).toContain('status=ACTIVE');
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });

  it('lab_get_device_token_events forwards limit for one token', async () => {
    const calls: StubCall[] = [];
    const { client } = await createTestServer(
      stubApi({ 'GET /api/hub/device-tokens/t1/events': { status: 200, body: { events: [] } } }, calls),
    );
    const result = await client.callTool({
      name: 'lab_get_device_token_events',
      arguments: { tokenId: 't1', limit: 10 },
    });
    expect(calls[0]?.path).toContain('limit=10');
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ events: [] }) }]);
  });

  it('lab_get_zone_runtime returns the per-zone assembly', async () => {
    const body = [{ zone: 'sim-zone', leader: { bridge: 'spoke-0' } }];
    const { client } = await createTestServer(stubApi({ 'GET /api/runtime/zones': { status: 200, body } }));
    const result = await client.callTool({ name: 'lab_get_zone_runtime', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(body) }]);
  });
});
