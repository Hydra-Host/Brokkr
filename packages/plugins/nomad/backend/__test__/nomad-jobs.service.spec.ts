import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NomadConfig } from '../../schemas';
import { BRIDGE_SERVICES_SAMPLE_VARIABLES } from '../jobspecs';
import { NomadClient } from '../nomad.client';
import { NomadHttpError } from '../nomad.errors';
import { NomadJobsService } from '../nomad-jobs.service';

const config: NomadConfig = {
  address: 'http://nomad.test:4646',
  token: 'test-acl-token',
  namespace: 'default',
  timeoutMs: 5_000,
  tlsSkipVerify: false,
};

function stubJsonFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('NomadJobsService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validate returns status ok for a known-good jobspec + vars against mock Nomad', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return { status: 200, body: { ID: 'bridge-services', Name: 'bridge-services', Type: 'system' } };
      }
      if (url.includes('/v1/validate/job')) {
        return { status: 200, body: { ValidationErrors: null, Warnings: '', DriverConfigValidated: true } };
      }
      return { status: 404, body: { message: 'unexpected' } };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.validate({
      jobspecId: 'bridge-services',
      variables: { ...BRIDGE_SERVICES_SAMPLE_VARIABLES },
    });

    expect(result.status).toBe('ok');
    expect(result.jobId).toBe(BRIDGE_SERVICES_SAMPLE_VARIABLES.job_name);
    expect(result.errors).toBeUndefined();
  });

  it('validate returns status error for invalid HCL without throwing', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return { status: 400, body: 'failed to parse' };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.validate({ jobHCL: 'not valid hcl {{{' });

    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toMatch(/failed|parse|HTTP/i);
  });

  it('plan returns status ok against mock Nomad', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return { status: 200, body: { ID: 'bridge-services', Name: 'bridge-services' } };
      }
      if (url.includes('/plan')) {
        return {
          status: 200,
          body: { JobModifyIndex: 1, Diff: { Type: 'Added' }, FailedTGAllocs: null },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.plan({
      jobspecId: 'bridge-services',
      variables: { ...BRIDGE_SERVICES_SAMPLE_VARIABLES },
    });

    expect(result.status).toBe('ok');
    expect(result.failedPlacements).toBe(false);
    expect(result.diffSummary).toBe('plan added');
    expect(result.jobId).toBe(BRIDGE_SERVICES_SAMPLE_VARIABLES.job_name);
  });

  it('shipped jobspec aligns Job.Namespace and parse Variables with request namespace', async () => {
    const fetchMock = stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return {
          status: 200,
          body: { ID: 'bridge-services', Name: 'bridge-services', Namespace: 'default', Type: 'system' },
        };
      }
      if (url.includes('/v1/jobs?')) {
        return {
          status: 200,
          body: { EvalID: 'eval-ns', EvalCreateIndex: 1, JobModifyIndex: 2 },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.submit({
      jobspecId: 'bridge-services',
      namespace: 'brokkr',
      variables: { ...BRIDGE_SERVICES_SAMPLE_VARIABLES },
    });

    expect(result.status).toBe('ok');
    const parseCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/jobs/parse')) as
      | [string, RequestInit]
      | undefined;
    const submitCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/jobs?')) as
      | [string, RequestInit]
      | undefined;
    expect(parseCall?.[0]).toContain('namespace=brokkr');
    expect(JSON.parse(String(parseCall?.[1].body))).toMatchObject({
      Variables: expect.stringContaining('"namespace":"brokkr"'),
    });
    expect(submitCall?.[0]).toContain('namespace=brokkr');
    expect(JSON.parse(String(submitCall?.[1].body))).toMatchObject({
      Job: expect.objectContaining({ Namespace: 'brokkr' }),
    });
  });

  it('inline jobHCL keeps job_name in Nomad Variables and does not rename Job.ID', async () => {
    const fetchMock = stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return { status: 200, body: { ID: 'from-hcl-label', Name: 'from-hcl-label', Type: 'service' } };
      }
      if (url.includes('/v1/validate/job')) {
        return { status: 200, body: { ValidationErrors: null, DriverConfigValidated: true } };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.validate({
      jobHCL: 'variable "job_name" { type = string }\njob "from-hcl-label" { type = "service" datacenters = ["dc1"] }',
      variables: { job_name: 'should-reach-nomad' },
    });

    expect(result.status).toBe('ok');
    expect(result.jobId).toBe('from-hcl-label');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { Variables: string };
    expect(body.Variables).toContain('"job_name"');
    expect(body.Variables).toContain('should-reach-nomad');
  });

  it('plan with diff:false tolerates Nomad Diff:null', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return { status: 200, body: { ID: 'bridge-services' } };
      }
      if (url.includes('/plan')) {
        return { status: 200, body: { JobModifyIndex: 1, Diff: null, FailedTGAllocs: null } };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.plan({
      job: { ID: 'bridge-services' },
      diff: false,
    });

    expect(result.status).toBe('ok');
    expect(result.diffSummary).toBe('plan ok');
  });

  it('submit returns ok with jobId and evalId (create-or-update)', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return { status: 200, body: { ID: 'bridge-services', Name: 'bridge-services' } };
      }
      if (url.endsWith('/v1/jobs?namespace=default') || url.includes('/v1/jobs?')) {
        return {
          status: 200,
          body: { EvalID: 'eval-abc', EvalCreateIndex: 1, JobModifyIndex: 2 },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.submit({
      jobspecId: 'bridge-services',
      variables: { ...BRIDGE_SERVICES_SAMPLE_VARIABLES },
    });

    expect(result.status).toBe('ok');
    expect(result.jobId).toBe(BRIDGE_SERVICES_SAMPLE_VARIABLES.job_name);
    expect(result.evalId).toBe('eval-abc');
    expect(result.submittedAt).toMatch(/^\d{4}-/);
  });

  it('submit returns status error on Nomad rejection', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/v1/jobs/parse')) {
        return { status: 200, body: { ID: 'bridge-services-example' } };
      }
      if (url.includes('/v1/jobs')) {
        return { status: 500, body: 'permission denied' };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.submit({ job: { ID: 'bridge-services-example' } });

    expect(result.status).toBe('error');
    expect(result.evalId).toBeNull();
    expect(result.error).toMatch(/permission denied|HTTP 500/i);
  });

  it('status returns structured not-ok when job is missing (not 500)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'not found',
      }),
    );

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.status({ jobId: 'missing-job' });

    expect(result.ok).toBe(false);
    expect(result.done).toBe(true);
    expect(result.stage).toBe('failed');
    expect(result.failures[0]).toMatch(/not found/i);
    expect(NomadHttpError).toBeTruthy();
  });

  it('status reports running when allocs are healthy', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/allocations')) {
        return {
          status: 200,
          body: [
            {
              ID: 'alloc-1',
              JobID: 'job-1',
              ClientStatus: 'running',
              TaskGroup: 'api',
              JobVersion: 1,
              TaskStates: { app: { State: 'running', Failed: false } },
            },
          ],
        };
      }
      if (url.includes('/v1/job/')) {
        return {
          status: 200,
          body: {
            Status: 'running',
            Version: 1,
            TaskGroups: [{ Name: 'api', Tasks: [{ Name: 'app' }] }],
          },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.status({ jobId: 'job-1', elapsedMs: 1000 });

    expect(result.stage).toBe('running');
    expect(result.done).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('dispatch returns dispatchedJobId + evalId and forwards namespace like stop', async () => {
    const fetchMock = stubJsonFetch((url) => {
      if (url.includes('/v1/job/facts/dispatch')) {
        return {
          status: 200,
          body: { DispatchedJobID: 'facts/dispatch-1722890000-abcdef', EvalID: 'eval-d1' },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.dispatch({
      jobId: 'facts',
      meta: { zone_id: 'z-9' },
      payload: 'collect these facts',
      namespace: 'brokkr',
    });

    expect(result).toEqual({
      status: 'ok',
      error: null,
      dispatchedJobId: 'facts/dispatch-1722890000-abcdef',
      evalId: 'eval-d1',
      jobId: 'facts',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/job/facts/dispatch?namespace=brokkr');
    const body = JSON.parse(String(init.body)) as { Payload: string };
    expect(body.Payload).toBe(Buffer.from('collect these facts', 'utf8').toString('base64'));
  });

  it('dispatch returns status error on Nomad rejection', async () => {
    stubJsonFetch(() => ({ status: 500, body: 'job is not parameterized' }));

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.dispatch({ jobId: 'not-parameterized' });

    expect(result.status).toBe('error');
    expect(result.dispatchedJobId).toBeNull();
    expect(result.evalId).toBeNull();
    expect(result.jobId).toBe('not-parameterized');
    expect(result.error).toMatch(/not parameterized|HTTP 500/i);
  });

  it('allocs maps alloc stubs (node, task states, timestamps) for a dispatched child job', async () => {
    const fetchMock = stubJsonFetch((url) => {
      if (url.includes('/allocations')) {
        return {
          status: 200,
          body: [
            {
              ID: 'alloc-1',
              JobID: 'facts/dispatch-1722890000-abcdef',
              Name: 'facts/dispatch-1722890000-abcdef.collect[0]',
              NodeID: 'node-1',
              NodeName: 'client-a',
              ClientStatus: 'complete',
              TaskGroup: 'collect',
              CreateTime: 1_722_890_000_000_000_000,
              ModifyTime: 1_722_890_060_000_000_000,
              TaskStates: {
                collect: { State: 'dead', Failed: false, FinishedAt: '2026-08-04T20:01:00Z' },
              },
            },
          ],
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.allocs({ jobId: 'facts/dispatch-1722890000-abcdef' });

    expect(result.status).toBe('ok');
    expect(result.jobId).toBe('facts/dispatch-1722890000-abcdef');
    expect(result.allocs).toHaveLength(1);
    expect(result.allocs[0]).toMatchObject({
      id: 'alloc-1',
      nodeId: 'node-1',
      nodeName: 'client-a',
      clientStatus: 'complete',
      taskGroup: 'collect',
      createTime: 1_722_890_000_000_000_000,
      modifyTime: 1_722_890_060_000_000_000,
    });
    expect(result.allocs[0]?.tasks).toEqual([
      { task: 'collect', state: 'dead', failed: false, finishedAt: '2026-08-04T20:01:00Z' },
    ]);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toContain('facts%2Fdispatch-1722890000-abcdef');
  });

  it('allocs returns status error with empty allocs on Nomad failure', async () => {
    stubJsonFetch(() => ({ status: 500, body: 'rpc error' }));

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.allocs({ jobId: 'job-1' });

    expect(result.status).toBe('error');
    expect(result.allocs).toEqual([]);
    expect(result.jobId).toBe('job-1');
    expect(result.error).toMatch(/rpc error|HTTP 500/i);
  });

  it('readJob maps task groups to camelCase config/resources/env', async () => {
    const fetchMock = stubJsonFetch((url) => {
      if (url.includes('/v1/job/zone-bridge')) {
        return {
          status: 200,
          body: {
            ID: 'zone-bridge',
            Name: 'zone-bridge',
            Status: 'running',
            TaskGroups: [
              {
                Name: 'api',
                Tasks: [
                  {
                    Name: 'app',
                    Config: { image: 'registry.example/app:1', args: ['--serve'] },
                    Resources: { CPU: 500, MemoryMB: 256 },
                    Env: { PORT: '80', HOST: '0.0.0.0' },
                  },
                ],
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.readJob({ jobId: 'zone-bridge' });

    expect(result).toEqual({
      status: 'ok',
      error: null,
      jobId: 'zone-bridge',
      name: 'zone-bridge',
      jobStatus: 'running',
      taskGroups: [
        {
          name: 'api',
          tasks: [
            {
              task: 'app',
              config: { image: 'registry.example/app:1', args: ['--serve'] },
              resources: { cpu: 500, memoryMB: 256 },
              env: { PORT: '80', HOST: '0.0.0.0' },
            },
          ],
        },
      ],
    });
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toContain('/v1/job/zone-bridge');
  });

  it('readJob tolerates null Config/Resources/Env and missing TaskGroups fields', async () => {
    stubJsonFetch(() => ({
      status: 200,
      body: {
        ID: 'sparse-job',
        Name: null,
        Status: null,
        TaskGroups: [{ Name: 'g', Tasks: [{ Name: 't', Config: null, Resources: null, Env: null }] }, { Name: 'empty' }],
      },
    }));

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.readJob({ jobId: 'sparse-job' });

    expect(result.status).toBe('ok');
    expect(result.name).toBeNull();
    expect(result.jobStatus).toBeNull();
    expect(result.taskGroups).toEqual([
      { name: 'g', tasks: [{ task: 't', config: null, resources: { cpu: null, memoryMB: null }, env: null }] },
      { name: 'empty', tasks: [] },
    ]);
  });

  it('readJob returns status error with empty taskGroups on Nomad failure', async () => {
    stubJsonFetch(() => ({ status: 404, body: 'job not found' }));

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.readJob({ jobId: 'missing-job' });

    expect(result.status).toBe('error');
    expect(result.jobId).toBe('missing-job');
    expect(result.name).toBeNull();
    expect(result.jobStatus).toBeNull();
    expect(result.taskGroups).toEqual([]);
    expect(result.error).toMatch(/not found|HTTP 404/i);
  });

  it('logs returns raw text with echoed read parameters', async () => {
    const rawLog = 'collector started\ncollector finished\n';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => rawLog });
    vi.stubGlobal('fetch', fetchMock);

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.logs({
      allocId: 'alloc-1',
      task: 'collect',
      type: 'stderr',
      origin: 'end',
      offset: 2048,
    });

    expect(result).toEqual({
      status: 'ok',
      error: null,
      text: rawLog,
      allocId: 'alloc-1',
      task: 'collect',
      type: 'stderr',
      origin: 'end',
      offset: 2048,
    });
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toContain('/v1/client/fs/logs/alloc-1');
  });

  it('logs returns status error with null text on Nomad failure', async () => {
    stubJsonFetch(() => ({ status: 404, body: 'unknown allocation' }));

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.logs({
      allocId: 'missing',
      task: 'collect',
      type: 'stdout',
      origin: 'end',
      offset: 16_384,
    });

    expect(result.status).toBe('error');
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/unknown allocation|HTTP 404/i);
  });

  it('nodes lists node stubs with null meta (list stubs omit Meta)', async () => {
    stubJsonFetch((url) => {
      if (url.endsWith('/v1/nodes')) {
        return {
          status: 200,
          body: [
            {
              ID: 'node-1',
              Name: 'client-a',
              Status: 'ready',
              SchedulingEligibility: 'eligible',
              Datacenter: 'dc1',
              NodePool: 'default',
              Address: '10.0.0.5',
              Version: '1.8.0',
              Drivers: { docker: { Detected: true, Healthy: true }, exec: { Detected: false } },
            },
          ],
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.nodes({});

    expect(result.status).toBe('ok');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: 'node-1',
      name: 'client-a',
      status: 'ready',
      schedulingEligibility: 'eligible',
      datacenter: 'dc1',
      nodePool: 'default',
      address: '10.0.0.5',
      version: '1.8.0',
      meta: null,
    });
    expect(result.nodes[0]?.drivers).toEqual({
      docker: { detected: true, healthy: true },
      exec: { detected: false, healthy: null },
    });
  });

  it('nodes with nodeId reads the detail endpoint and returns meta + attribute version', async () => {
    const fetchMock = stubJsonFetch((url) => {
      if (url.includes('/v1/node/node-1')) {
        return {
          status: 200,
          body: {
            ID: 'node-1',
            Name: 'client-a',
            Status: 'ready',
            SchedulingEligibility: 'eligible',
            Datacenter: 'dc1',
            NodePool: 'default',
            HTTPAddr: '10.0.0.5:4646',
            Attributes: { 'nomad.version': '1.8.0' },
            Meta: { rack: 'r1', zone: 'z-9' },
            Drivers: { docker: { Detected: true, Healthy: true } },
          },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.nodes({ nodeId: 'node-1' });

    expect(result.status).toBe('ok');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.meta).toEqual({ rack: 'r1', zone: 'z-9' });
    expect(result.nodes[0]?.version).toBe('1.8.0');
    expect(result.nodes[0]?.address).toBe('10.0.0.5:4646');
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/v1/node/node-1');
  });

  it('nodes returns status error with empty nodes on Nomad failure', async () => {
    stubJsonFetch(() => ({ status: 403, body: 'Permission denied' }));

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.nodes({});

    expect(result.status).toBe('error');
    expect(result.nodes).toEqual([]);
    expect(result.error).toMatch(/permission denied|HTTP 403/i);
  });

  it('stop returns status ok and forwards purge=false by default', async () => {
    const fetchMock = stubJsonFetch((url) => {
      if (url.includes('/v1/job/job-1') && url.includes('purge=false')) {
        return {
          status: 200,
          body: { EvalID: 'eval-stop', EvalCreateIndex: 1, JobModifyIndex: 2 },
        };
      }
      return { status: 404, body: {} };
    });

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.stop({ jobId: 'job-1' });

    expect(result.status).toBe('ok');
    expect(result.evalId).toBe('eval-stop');
    expect(result.jobId).toBe('job-1');
    expect(result.purge).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('purge=false');
    expect(init.method).toBe('DELETE');
  });

  it('stop returns status error on Nomad rejection', async () => {
    stubJsonFetch(() => ({ status: 500, body: 'permission denied' }));

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.stop({ jobId: 'job-1', purge: true });

    expect(result.status).toBe('error');
    expect(result.evalId).toBeNull();
    expect(result.jobId).toBe('job-1');
    expect(result.purge).toBe(true);
    expect(result.error).toMatch(/permission denied|HTTP 500/i);
  });
});
