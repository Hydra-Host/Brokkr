import { describe, expect, it } from 'vitest';

import {
  NomadAllocsQuerySchema,
  NomadAllocsResultSchema,
  NomadDispatchRequestSchema,
  NomadDispatchResultSchema,
  NomadJobQuerySchema,
  NomadJobReadResultSchema,
  NomadJobRequestSchema,
  NomadLogsQuerySchema,
  NomadLogsResultSchema,
  NomadNodesQuerySchema,
  NomadNodesResultSchema,
  NomadPlanResultSchema,
  NomadStartupStatusSchema,
  NomadStopRequestSchema,
  NomadStopResultSchema,
  NomadSubmitResultSchema,
  NomadValidateResultSchema,
} from '../../schemas';

describe('nomad contract schemas', () => {
  it('accepts a valid validate result and rejects a bad one', () => {
    expect(() =>
      NomadValidateResultSchema.parse({ status: 'ok', warnings: null, jobId: 'job-1' }),
    ).not.toThrow();
    expect(() => NomadValidateResultSchema.parse({ status: 'nope' })).toThrow();
  });

  it('accepts a valid plan result and rejects missing failedPlacements', () => {
    expect(() =>
      NomadPlanResultSchema.parse({
        status: 'ok',
        error: null,
        diffSummary: 'plan edited',
        failedPlacements: false,
        warnings: null,
        jobId: 'job-1',
      }),
    ).not.toThrow();
    expect(() => NomadPlanResultSchema.parse({ status: 'ok' })).toThrow();
  });

  it('accepts a valid submit result and rejects missing evalId', () => {
    expect(() =>
      NomadSubmitResultSchema.parse({
        status: 'ok',
        error: null,
        evalId: 'eval-1',
        jobId: 'job-1',
        submittedAt: '2026-07-30T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(() => NomadSubmitResultSchema.parse({ status: 'ok', jobId: 'x' })).toThrow();
  });

  it('accepts a valid stop request/result and rejects missing purge on result', () => {
    expect(() => NomadStopRequestSchema.parse({ jobId: 'job-1', purge: true })).not.toThrow();
    expect(() =>
      NomadStopResultSchema.parse({
        status: 'ok',
        error: null,
        evalId: 'eval-1',
        jobId: 'job-1',
        purge: false,
      }),
    ).not.toThrow();
    expect(() => NomadStopResultSchema.parse({ status: 'ok', evalId: null, jobId: 'x' })).toThrow();
  });

  it('accepts a valid startup status and rejects a bad stage', () => {
    expect(() =>
      NomadStartupStatusSchema.parse({
        stage: 'running',
        done: true,
        ok: true,
        tasks: [],
        failures: [],
        softTimeoutReached: false,
        message: null,
      }),
    ).not.toThrow();
    expect(() =>
      NomadStartupStatusSchema.parse({
        stage: 'bogus',
        done: true,
        ok: true,
        tasks: [],
        failures: [],
        softTimeoutReached: false,
      }),
    ).toThrow();
  });

  it('accepts a valid allocs result and rejects a query missing jobId', () => {
    expect(() => NomadAllocsQuerySchema.parse({ jobId: 'facts/dispatch-1-a' })).not.toThrow();
    expect(() => NomadAllocsQuerySchema.parse({})).toThrow();
    expect(() =>
      NomadAllocsResultSchema.parse({
        status: 'ok',
        error: null,
        jobId: 'facts/dispatch-1-a',
        allocs: [
          {
            id: 'alloc-1',
            name: null,
            nodeId: 'node-1',
            nodeName: 'client-a',
            clientStatus: 'complete',
            taskGroup: 'collect',
            tasks: [{ task: 'collect', state: 'dead', failed: false, finishedAt: null }],
            createTime: 1,
            modifyTime: 2,
          },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts a valid job read result and rejects a query missing jobId', () => {
    expect(() => NomadJobQuerySchema.parse({ jobId: 'zone-bridge', namespace: 'brokkr' })).not.toThrow();
    expect(() => NomadJobQuerySchema.parse({})).toThrow();
    expect(() =>
      NomadJobReadResultSchema.parse({
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
                config: { image: 'registry.example/app:1' },
                resources: { cpu: 500, memoryMB: 256 },
                env: { PORT: '80' },
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
    expect(() => NomadJobReadResultSchema.parse({ status: 'ok', jobId: 'x' })).toThrow();
  });

  it('accepts a valid dispatch request/result and rejects missing jobId', () => {
    expect(() =>
      NomadDispatchRequestSchema.parse({ jobId: 'facts', meta: { zone_id: 'z' }, payload: 'p' }),
    ).not.toThrow();
    expect(() => NomadDispatchRequestSchema.parse({ meta: {} })).toThrow();
    expect(() =>
      NomadDispatchResultSchema.parse({
        status: 'ok',
        error: null,
        dispatchedJobId: 'facts/dispatch-1-a',
        evalId: 'eval-1',
        jobId: 'facts',
      }),
    ).not.toThrow();
    expect(() => NomadDispatchResultSchema.parse({ status: 'ok', jobId: 'facts' })).toThrow();
  });

  it('applies logs query defaults and coerces offset from a query string', () => {
    const parsed = NomadLogsQuerySchema.parse({ allocId: 'alloc-1', task: 'collect', offset: '4096' });
    expect(parsed).toEqual({
      allocId: 'alloc-1',
      task: 'collect',
      type: 'stdout',
      origin: 'end',
      offset: 4096,
    });
    expect(() => NomadLogsQuerySchema.parse({ allocId: 'alloc-1' })).toThrow();
    expect(() =>
      NomadLogsResultSchema.parse({
        status: 'ok',
        error: null,
        text: 'log line\n',
        allocId: 'alloc-1',
        task: 'collect',
        type: 'stdout',
        origin: 'end',
        offset: 16_384,
      }),
    ).not.toThrow();
  });

  it('accepts a valid nodes result and rejects a node missing id', () => {
    expect(() => NomadNodesQuerySchema.parse({ nodeId: 'node-1' })).not.toThrow();
    expect(() =>
      NomadNodesResultSchema.parse({
        status: 'ok',
        error: null,
        nodes: [
          {
            id: 'node-1',
            name: 'client-a',
            status: 'ready',
            schedulingEligibility: 'eligible',
            datacenter: 'dc1',
            nodePool: 'default',
            address: '10.0.0.5',
            version: '1.8.0',
            drivers: { docker: { detected: true, healthy: true } },
            meta: null,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      NomadNodesResultSchema.parse({ status: 'ok', nodes: [{ name: 'missing-id' }] }),
    ).toThrow();
  });

  it('accepts job request with shipped id + variables', () => {
    expect(() =>
      NomadJobRequestSchema.parse({
        jobspecId: 'bridge-services',
        variables: { job_name: 'x', datacenter: 'dc1', zone_id: 'z', bridge_api_image: 'i', bind_image: 'i', kea_image: 'i' },
      }),
    ).not.toThrow();
  });
});
