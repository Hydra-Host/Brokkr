import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NomadConfig } from '../../schemas';
import { NomadClient } from '../nomad.client';
import { NomadHttpError } from '../nomad.errors';

const { AgentMock, undiciFetchMock } = vi.hoisted(() => ({
  AgentMock: vi.fn(),
  undiciFetchMock: vi.fn(),
}));

vi.mock('undici', () => ({
  Agent: AgentMock,
  fetch: undiciFetchMock,
}));

const config: NomadConfig = {
  address: 'http://nomad.test:4646',
  token: 'test-acl-token',
  namespace: 'default',
  timeoutMs: 5_000,
  tlsSkipVerify: false,
};

function stubJsonFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('NomadClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    AgentMock.mockReset();
    undiciFetchMock.mockReset();
  });

  it('when tlsSkipVerify, builds undici Agent, warns, and uses undici fetch with dispatcher', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const dispatcherInstance = { kind: 'skip-verify-agent' };
    AgentMock.mockImplementation(function Agent(this: { kind: string }, opts: unknown) {
      expect(opts).toEqual({ connect: { rejectUnauthorized: false } });
      Object.assign(this, dispatcherInstance);
      return this;
    });
    undiciFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ID: 'bridge-services', Type: 'service' }),
    });

    const client = new NomadClient({ ...config, tlsSkipVerify: true });
    expect(AgentMock).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('NOMAD_SKIP_VERIFY is enabled'),
    );

    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);

    await client.parseJob({ jobHCL: 'job "x" {}' });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(undiciFetchMock).toHaveBeenCalledOnce();
    const [, init] = undiciFetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(init.dispatcher).toMatchObject(dispatcherInstance);
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('parseJob posts to /v1/jobs/parse with X-Nomad-Token from config', async () => {
    const fetchMock = stubJsonFetch(200, { ID: 'bridge-services', Type: 'service' });
    const client = new NomadClient(config);

    const result = await client.parseJob({ jobHCL: 'job "x" {}' });
    expect(result).toEqual({ ID: 'bridge-services', Type: 'service' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://nomad.test:4646/v1/jobs/parse?namespace=default');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('validateJob posts to /v1/validate/job', async () => {
    const fetchMock = stubJsonFetch(200, { ValidationErrors: null, DriverConfigValidated: true });
    const client = new NomadClient(config);

    const result = await client.validateJob({ job: { ID: 'x' } });
    expect(result.ValidationErrors).toBeNull();
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/v1/validate/job?namespace=default');
  });

  it('planJob posts to /v1/job/{id}/plan', async () => {
    const fetchMock = stubJsonFetch(200, { JobModifyIndex: 1, FailedTGAllocs: null });
    const client = new NomadClient(config);

    await client.planJob({ jobId: 'bridge-services', job: { ID: 'bridge-services' } });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain(
      '/v1/job/bridge-services/plan?namespace=default',
    );
  });

  it('submitParsedJob posts to /v1/jobs with token header', async () => {
    const fetchMock = stubJsonFetch(200, {
      EvalID: 'eval-1',
      EvalCreateIndex: 1,
      JobModifyIndex: 2,
    });
    const client = new NomadClient(config);

    const result = await client.submitParsedJob({ job: { ID: 'bridge-services' } });
    expect(result.EvalID).toBe('eval-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://nomad.test:4646/v1/jobs?namespace=default');
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('getEvaluation reads /v1/evaluation/{id}', async () => {
    const fetchMock = stubJsonFetch(200, {
      ID: 'eval-1',
      JobID: 'job',
      Status: 'complete',
      FailedTGAllocs: null,
    });
    const client = new NomadClient(config);

    await client.getEvaluation({ evalId: 'eval-1' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/v1/evaluation/eval-1');
  });

  it('getJobAllocations preserves dead-but-not-Failed lifecycle tasks', async () => {
    const fetchMock = stubJsonFetch(200, [
      {
        ID: 'alloc-1',
        JobID: 'job',
        ClientStatus: 'running',
        TaskStates: {
          setup: { State: 'dead', Failed: false },
          app: { State: 'running', Failed: false },
        },
      },
    ]);
    const client = new NomadClient(config);

    const allocs = await client.getJobAllocations({ jobId: 'job' });
    expect(allocs[0]?.TaskStates?.setup).toMatchObject({ State: 'dead', Failed: false });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/v1/job/job/allocations');
  });

  it('getJob reads /v1/job/{id}', async () => {
    const fetchMock = stubJsonFetch(200, {
      Status: 'running',
      Version: 1,
      TaskGroups: [{ Name: 'g', Tasks: [{ Name: 't' }] }],
    });
    const client = new NomadClient(config);

    const job = await client.getJob({ jobId: 'job' });
    expect(job.Version).toBe(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/v1/job/job?namespace=default');
  });

  it('readJob reads /v1/job/{id} and preserves task Config/Resources/Env', async () => {
    const fetchMock = stubJsonFetch(200, {
      ID: 'zone-bridge',
      Name: 'zone-bridge',
      Status: 'running',
      TaskGroups: [
        {
          Name: 'api',
          Tasks: [
            {
              Name: 'app',
              Config: { image: 'registry.example/app:1' },
              Resources: { CPU: 500, MemoryMB: 256 },
              Env: { PORT: '80' },
            },
          ],
        },
      ],
    });
    const client = new NomadClient(config);

    const job = await client.readJob({ jobId: 'zone-bridge' });
    expect(job.Status).toBe('running');
    expect(job.TaskGroups?.[0]?.Tasks?.[0]).toMatchObject({
      Name: 'app',
      Config: { image: 'registry.example/app:1' },
      Resources: { CPU: 500, MemoryMB: 256 },
      Env: { PORT: '80' },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://nomad.test:4646/v1/job/zone-bridge?namespace=default');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('readJob URL-encodes dispatched child job IDs and forwards namespace', async () => {
    const fetchMock = stubJsonFetch(200, { ID: 'facts/dispatch-1', Status: 'dead', TaskGroups: null });
    const client = new NomadClient(config);

    await client.readJob({ jobId: 'facts/dispatch-1', namespace: 'brokkr' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://nomad.test:4646/v1/job/facts%2Fdispatch-1?namespace=brokkr');
  });

  it('deregisterJob deletes /v1/job/{id} with purge query', async () => {
    const fetchMock = stubJsonFetch(200, {
      EvalID: 'eval-stop-1',
      EvalCreateIndex: 3,
      JobModifyIndex: 4,
    });
    const client = new NomadClient(config);

    const result = await client.deregisterJob({ jobId: 'bridge-services-smoke', purge: true });
    expect(result.EvalID).toBe('eval-stop-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://nomad.test:4646/v1/job/bridge-services-smoke?namespace=default&purge=true',
    );
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('dispatchJob posts base64 Payload and Meta to /v1/job/{id}/dispatch', async () => {
    const fetchMock = stubJsonFetch(200, {
      DispatchedJobID: 'facts/dispatch-1722890000-abcdef',
      EvalID: 'eval-dispatch-1',
      EvalCreateIndex: 1,
      JobCreateIndex: 2,
    });
    const client = new NomadClient(config);

    const result = await client.dispatchJob({
      jobId: 'facts',
      meta: { zone_id: 'z-9' },
      payload: 'hello payload',
    });
    expect(result.DispatchedJobID).toBe('facts/dispatch-1722890000-abcdef');
    expect(result.EvalID).toBe('eval-dispatch-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://nomad.test:4646/v1/job/facts/dispatch?namespace=default');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { Meta: Record<string, string>; Payload: string };
    expect(body.Meta).toEqual({ zone_id: 'z-9' });
    expect(body.Payload).toBe(Buffer.from('hello payload', 'utf8').toString('base64'));
  });

  it('dispatchJob omits Payload when no payload is given', async () => {
    const fetchMock = stubJsonFetch(200, { DispatchedJobID: 'facts/dispatch-2', EvalID: 'eval-2' });
    const client = new NomadClient(config);

    await client.dispatchJob({ jobId: 'facts' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ Meta: {} });
    expect('Payload' in body).toBe(false);
  });

  it('getJobAllocations URL-encodes dispatched child job IDs (slash in jobId)', async () => {
    const fetchMock = stubJsonFetch(200, [
      {
        ID: 'alloc-1',
        JobID: 'facts/dispatch-1722890000-abcdef',
        NodeID: 'node-1',
        NodeName: 'client-a',
        ClientStatus: 'complete',
        CreateTime: 1_722_890_000_000_000_000,
        ModifyTime: 1_722_890_060_000_000_000,
        TaskStates: { collect: { State: 'dead', Failed: false, FinishedAt: '2026-08-04T20:00:00Z' } },
      },
    ]);
    const client = new NomadClient(config);

    const allocs = await client.getJobAllocations({ jobId: 'facts/dispatch-1722890000-abcdef' });
    expect(allocs[0]?.NodeID).toBe('node-1');
    expect(allocs[0]?.CreateTime).toBe(1_722_890_000_000_000_000);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'http://nomad.test:4646/v1/job/facts%2Fdispatch-1722890000-abcdef/allocations?namespace=default',
    );
  });

  it('listNodes reads /v1/nodes without a namespace param', async () => {
    const fetchMock = stubJsonFetch(200, [
      {
        ID: 'node-1',
        Name: 'client-a',
        Status: 'ready',
        SchedulingEligibility: 'eligible',
        Datacenter: 'dc1',
        NodePool: 'default',
        Address: '10.0.0.5',
        Version: '1.8.0',
        Drivers: { docker: { Detected: true, Healthy: true } },
      },
    ]);
    const client = new NomadClient(config);

    const nodes = await client.listNodes();
    expect(nodes[0]?.ID).toBe('node-1');
    expect(nodes[0]?.Drivers?.docker).toMatchObject({ Detected: true, Healthy: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://nomad.test:4646/v1/nodes');
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('getNode reads /v1/node/{id} and preserves Meta + Attributes', async () => {
    const fetchMock = stubJsonFetch(200, {
      ID: 'node-1',
      Name: 'client-a',
      Status: 'ready',
      SchedulingEligibility: 'eligible',
      Datacenter: 'dc1',
      NodePool: 'default',
      HTTPAddr: '10.0.0.5:4646',
      Attributes: { 'nomad.version': '1.8.0' },
      Meta: { rack: 'r1' },
      Drivers: { docker: { Detected: true, Healthy: false } },
    });
    const client = new NomadClient(config);

    const node = await client.getNode({ nodeId: 'node-1' });
    expect(node.Meta).toEqual({ rack: 'r1' });
    expect(node.Attributes?.['nomad.version']).toBe('1.8.0');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://nomad.test:4646/v1/node/node-1');
  });

  it('getAllocLogs reads /v1/client/fs/logs/{allocId} as plain text (no JSON parse)', async () => {
    const rawLog = 'line one\n{"looks":"like json"}\nline three\n';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => rawLog });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NomadClient(config);

    const text = await client.getAllocLogs({ allocId: 'alloc-1', task: 'collect', type: 'stderr' });
    expect(text).toBe(rawLog);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://nomad.test:4646/v1/client/fs/logs/alloc-1' +
        '?namespace=default&task=collect&type=stderr&origin=end&offset=16384&plain=true&follow=false',
    );
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('getAllocLogs forwards origin=start and a custom offset', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'head' });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NomadClient(config);

    await client.getAllocLogs({ allocId: 'alloc-1', task: 'collect', type: 'stdout', origin: 'start', offset: 512 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('origin=start');
    expect(url).toContain('offset=512');
    expect(url).toContain('type=stdout');
  });

  it('surfaces Nomad 4xx as NomadHttpError and still sent X-Nomad-Token', async () => {
    const fetchMock = stubJsonFetch(403, { message: 'Permission denied' });
    const client = new NomadClient(config);

    await expect(client.parseJob({ jobHCL: 'job "x" {}' })).rejects.toBeInstanceOf(NomadHttpError);
    await expect(client.parseJob({ jobHCL: 'job "x" {}' })).rejects.toMatchObject({
      status: 403,
      path: expect.stringContaining('/v1/jobs/parse'),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Nomad-Token']).toBe('test-acl-token');
  });

  it('surfaces network failures as NomadHttpError with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED')),
    );
    const client = new NomadClient(config);

    await expect(client.getJob({ jobId: 'missing' })).rejects.toMatchObject({
      name: 'NomadHttpError',
      status: 0,
    });
  });
});

