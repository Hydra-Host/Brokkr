import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NomadAllocsResultSchema,
  NomadDispatchResultSchema,
  NomadLogsResultSchema,
  NomadNodesResultSchema,
  NomadPlanResultSchema,
  NomadStartupStatusSchema,
  NomadStopResultSchema,
  NomadSubmitResultSchema,
  NomadValidateResultSchema,
  type NomadConfig,
} from '../../schemas';
import { BRIDGE_SERVICES_SAMPLE_VARIABLES } from '../jobspecs';
import { NomadClient } from '../nomad.client';
import { NomadJobsService } from '../nomad-jobs.service';

const config: NomadConfig = {
  address: 'http://nomad.test:4646',
  token: 'test-acl-token',
  namespace: 'default',
  timeoutMs: 5_000,
  tlsSkipVerify: false,
};

const JOB_ID = BRIDGE_SERVICES_SAMPLE_VARIABLES.job_name;

function stubPipelineFetch() {
  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';

    if (u.includes('/v1/jobs/parse') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ID: 'bridge-services', Name: 'bridge-services', Type: 'system' }),
      };
    }
    if (u.includes('/v1/validate/job') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ValidationErrors: null, DriverConfigValidated: true }),
      };
    }
    if (u.includes('/plan') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ JobModifyIndex: 1, Diff: { Type: 'Added' }, FailedTGAllocs: null, Warnings: '' }),
      };
    }
    if ((u.endsWith('/v1/jobs?namespace=default') || u.includes('/v1/jobs?')) && method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ EvalID: 'eval-pipeline-1', EvalCreateIndex: 1, JobModifyIndex: 2 }),
      };
    }
    if (u.includes('/allocations')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              ID: 'alloc-1',
              JobID: JOB_ID,
              ClientStatus: 'running',
              TaskGroup: 'api',
              JobVersion: 1,
              TaskStates: { app: { State: 'running', Failed: false } },
            },
          ]),
      };
    }
    if (u.includes(`/v1/job/${encodeURIComponent(JOB_ID)}`) && method === 'DELETE') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ EvalID: 'eval-stop-1', EvalCreateIndex: 3, JobModifyIndex: 4 }),
      };
    }
    if (u.includes(`/v1/job/${encodeURIComponent(JOB_ID)}`) && method === 'GET') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            Status: 'running',
            Version: 1,
            TaskGroups: [{ Name: 'api', Tasks: [{ Name: 'app' }] }],
          }),
      };
    }
    return { ok: false, status: 404, text: async () => 'unexpected' };
  });
}

describe('deploy pipeline integration (mock Nomad)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validate → plan → submit → status → stop asserts contract field values', async () => {
    const fetchMock = stubPipelineFetch();
    vi.stubGlobal('fetch', fetchMock);

    const service = new NomadJobsService(new NomadClient(config));
    const vars = { ...BRIDGE_SERVICES_SAMPLE_VARIABLES };

    const validate = await service.validate({ jobspecId: 'bridge-services', variables: vars });
    expect(NomadValidateResultSchema.parse(validate).status).toBe('ok');
    expect(validate.jobId).toBe(JOB_ID);

    const plan = await service.plan({ jobspecId: 'bridge-services', variables: vars });
    expect(NomadPlanResultSchema.parse(plan).status).toBe('ok');
    expect(plan.failedPlacements).toBe(false);
    expect(plan.jobId).toBe(JOB_ID);

    const submit = await service.submit({ jobspecId: 'bridge-services', variables: vars });
    expect(NomadSubmitResultSchema.parse(submit).status).toBe('ok');
    expect(submit.evalId).toBe('eval-pipeline-1');
    expect(submit.jobId).toBe(JOB_ID);
    expect(submit.submittedAt).toMatch(/^\d{4}-/);

    const status = await service.status({ jobId: JOB_ID, elapsedMs: 1_000 });
    expect(NomadStartupStatusSchema.parse(status).stage).toBe('running');
    expect(status.done).toBe(true);
    expect(status.ok).toBe(true);

    const stop = await service.stop({ jobId: JOB_ID, purge: true });
    expect(NomadStopResultSchema.parse(stop).status).toBe('ok');
    expect(stop.evalId).toBe('eval-stop-1');
    expect(stop.jobId).toBe(JOB_ID);
    expect(stop.purge).toBe(true);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/v1/jobs/parse'))).toBe(true);
    expect(urls.some((u) => u.includes('/v1/validate/job'))).toBe(true);
    expect(urls.some((u) => u.includes('/plan'))).toBe(true);
    expect(urls.some((u) => u.includes('/v1/jobs?'))).toBe(true);
    expect(urls.some((u) => u.includes('/allocations'))).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) =>
          String(u).includes(`/v1/job/${encodeURIComponent(JOB_ID)}`) &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});

describe('dispatch observe pipeline integration (mock Nomad)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const PARENT_JOB = 'facts';
  const CHILD_JOB = 'facts/dispatch-1722890000-abcdef';
  const RAW_LOG = 'collect: starting\ncollect: done\n';

  function stubObservabilityFetch() {
    return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';

      if (u.includes(`/v1/job/${PARENT_JOB}/dispatch`) && method === 'POST') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ DispatchedJobID: CHILD_JOB, EvalID: 'eval-dispatch-1' }),
        };
      }
      if (u.includes(`/v1/job/${encodeURIComponent(CHILD_JOB)}/allocations`) && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              {
                ID: 'alloc-1',
                JobID: CHILD_JOB,
                NodeID: 'node-1',
                NodeName: 'client-a',
                ClientStatus: 'complete',
                TaskGroup: 'collect',
                CreateTime: 1,
                ModifyTime: 2,
                TaskStates: { collect: { State: 'dead', Failed: false, FinishedAt: '2026-08-04T20:01:00Z' } },
              },
            ]),
        };
      }
      if (u.includes('/v1/client/fs/logs/alloc-1') && method === 'GET') {
        return { ok: true, status: 200, text: async () => RAW_LOG };
      }
      if (u.endsWith('/v1/nodes') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
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
            ]),
        };
      }
      return { ok: false, status: 404, text: async () => 'unexpected' };
    });
  }

  it('dispatch → allocs → logs (+ nodes) asserts contract field values', async () => {
    const fetchMock = stubObservabilityFetch();
    vi.stubGlobal('fetch', fetchMock);

    const service = new NomadJobsService(new NomadClient(config));

    const dispatch = await service.dispatch({ jobId: PARENT_JOB, meta: { zone_id: 'z-9' }, payload: 'go' });
    expect(NomadDispatchResultSchema.parse(dispatch).status).toBe('ok');
    expect(dispatch.dispatchedJobId).toBe(CHILD_JOB);
    expect(dispatch.evalId).toBe('eval-dispatch-1');

    const allocs = await service.allocs({ jobId: dispatch.dispatchedJobId! });
    expect(NomadAllocsResultSchema.parse(allocs).status).toBe('ok');
    expect(allocs.allocs[0]).toMatchObject({ id: 'alloc-1', nodeName: 'client-a', clientStatus: 'complete' });
    expect(allocs.allocs[0]?.tasks[0]).toMatchObject({ task: 'collect', state: 'dead', failed: false });

    const logs = await service.logs({
      allocId: allocs.allocs[0]!.id,
      task: 'collect',
      type: 'stdout',
      origin: 'end',
      offset: 16_384,
    });
    expect(NomadLogsResultSchema.parse(logs).status).toBe('ok');
    expect(logs.text).toBe(RAW_LOG);

    const nodes = await service.nodes({});
    expect(NomadNodesResultSchema.parse(nodes).status).toBe('ok');
    expect(nodes.nodes[0]).toMatchObject({ id: 'node-1', status: 'ready', meta: null });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(`/v1/job/${PARENT_JOB}/dispatch`))).toBe(true);
    expect(urls.some((u) => u.includes(`/v1/job/${encodeURIComponent(CHILD_JOB)}/allocations`))).toBe(true);
    expect(urls.some((u) => u.includes('/v1/client/fs/logs/alloc-1') && u.includes('plain=true'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/v1/nodes'))).toBe(true);
  });
});

describe('deploy pipeline integration (optional real Nomad)', () => {
  const liveOptIn = process.env.NOMAD_LIVE_TEST === 'true';
  const realAddr = process.env.NOMAD_ADDR;
  const realToken = process.env.NOMAD_TOKEN;

  it.skipIf(!liveOptIn || !realAddr || !realToken)(
    'parse + validate against live Nomad when NOMAD_LIVE_TEST=true and NOMAD_ADDR/TOKEN are set',
    async () => {
      const client = new NomadClient({
        address: realAddr!,
        token: realToken!,
        namespace: process.env.NOMAD_NAMESPACE || 'default',
        timeoutMs: 15_000,
        tlsSkipVerify: process.env.NOMAD_SKIP_VERIFY === 'true' || process.env.NOMAD_SKIP_VERIFY === '1',
      });
      const service = new NomadJobsService(client);
      const validate = await service.validate({
        jobspecId: 'bridge-services',
        variables: { ...BRIDGE_SERVICES_SAMPLE_VARIABLES },
      });
      expect(validate.status).toBe('ok');
      expect(validate.jobId).toBe(JOB_ID);
    },
  );
});
