import { describe, expect, it } from 'vitest';

import {
  NomadAllocStubSchema,
  NomadDispatchJobResponseSchema,
  NomadEvaluationStatusSchema,
  NomadJobAllocationsResponseSchema,
  NomadJobSummarySchema,
  NomadNodeDetailSchema,
  NomadNodeStubSchema,
  NomadParsedJobSchema,
  NomadPlanJobResponseSchema,
  NomadSubmitJobResponseSchema,
  NomadValidateJobResponseSchema,
} from '../types/nomad-api';

describe('NomadParsedJobSchema', () => {
  it('accepts an opaque job object', () => {
    expect(NomadParsedJobSchema.parse({ ID: 'bridge-services', Type: 'service' })).toEqual({
      ID: 'bridge-services',
      Type: 'service',
    });
  });

  it('rejects non-objects', () => {
    expect(NomadParsedJobSchema.safeParse('not-a-job').success).toBe(false);
  });
});

describe('NomadValidateJobResponseSchema', () => {
  it('accepts a clean validation response with null ValidationErrors', () => {
    expect(
      NomadValidateJobResponseSchema.parse({
        ValidationErrors: null,
        DriverConfigValidated: true,
      }),
    ).toEqual({
      ValidationErrors: null,
      DriverConfigValidated: true,
    });
  });

  it('rejects a non-array ValidationErrors value', () => {
    expect(
      NomadValidateJobResponseSchema.safeParse({ ValidationErrors: 'bad' }).success,
    ).toBe(false);
  });
});

describe('NomadPlanJobResponseSchema', () => {
  it('accepts a plan response with FailedTGAllocs null', () => {
    expect(
      NomadPlanJobResponseSchema.parse({
        JobModifyIndex: 12,
        FailedTGAllocs: null,
        Diff: { Type: 'Added' },
      }),
    ).toMatchObject({ JobModifyIndex: 12, FailedTGAllocs: null });
  });

  it('accepts an explicit null Diff (Nomad plan with Diff:false)', () => {
    expect(
      NomadPlanJobResponseSchema.safeParse({
        JobModifyIndex: 1,
        Diff: null,
        FailedTGAllocs: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a missing JobModifyIndex', () => {
    expect(NomadPlanJobResponseSchema.safeParse({ Diff: {} }).success).toBe(false);
  });
});

describe('NomadSubmitJobResponseSchema', () => {
  it('accepts a submit response', () => {
    expect(
      NomadSubmitJobResponseSchema.parse({
        EvalID: 'eval-1',
        EvalCreateIndex: 3,
        JobModifyIndex: 4,
      }),
    ).toEqual({
      EvalID: 'eval-1',
      EvalCreateIndex: 3,
      JobModifyIndex: 4,
    });
  });

  it('rejects a submit response missing EvalID', () => {
    expect(
      NomadSubmitJobResponseSchema.safeParse({
        EvalCreateIndex: 1,
        JobModifyIndex: 2,
      }).success,
    ).toBe(false);
  });
});

describe('NomadEvaluationStatusSchema', () => {
  it('accepts a complete evaluation', () => {
    expect(
      NomadEvaluationStatusSchema.parse({
        ID: 'eval-1',
        JobID: 'bridge-services',
        Status: 'complete',
        FailedTGAllocs: null,
      }),
    ).toMatchObject({ ID: 'eval-1', Status: 'complete' });
  });

  it('rejects a missing Status', () => {
    expect(
      NomadEvaluationStatusSchema.safeParse({ ID: 'eval-1', JobID: 'job' }).success,
    ).toBe(false);
  });
});

describe('NomadJobAllocationsResponseSchema / NomadAllocStubSchema', () => {
  it('accepts an alloc with a lifecycle task that is dead but not Failed', () => {
    const alloc = NomadAllocStubSchema.parse({
      ID: 'alloc-1',
      JobID: 'bridge-services',
      ClientStatus: 'running',
      TaskStates: {
        setup: {
          State: 'dead',
          Failed: false,
          Events: [{ Type: 'Terminated', DisplayMessage: 'lifecycle complete' }],
        },
        app: {
          State: 'running',
          Failed: false,
        },
      },
    });

    expect(alloc.TaskStates?.setup).toMatchObject({ State: 'dead', Failed: false });
    expect(NomadJobAllocationsResponseSchema.parse([alloc])).toHaveLength(1);
  });

  it('rejects an alloc missing ClientStatus', () => {
    expect(NomadAllocStubSchema.safeParse({ ID: 'a', JobID: 'j' }).success).toBe(false);
  });
});

describe('NomadDispatchJobResponseSchema', () => {
  it('accepts a dispatch response and rejects one missing DispatchedJobID', () => {
    expect(
      NomadDispatchJobResponseSchema.parse({
        DispatchedJobID: 'facts/dispatch-1722890000-abcdef',
        EvalID: 'eval-1',
        EvalCreateIndex: 1,
        JobCreateIndex: 2,
      }),
    ).toMatchObject({ DispatchedJobID: 'facts/dispatch-1722890000-abcdef' });
    expect(NomadDispatchJobResponseSchema.safeParse({ EvalID: 'eval-1' }).success).toBe(false);
  });
});

describe('NomadNodeStubSchema / NomadNodeDetailSchema', () => {
  it('accepts a list stub without Meta and a detail with Meta + Attributes', () => {
    expect(
      NomadNodeStubSchema.parse({
        ID: 'node-1',
        Name: 'client-a',
        Status: 'ready',
        SchedulingEligibility: 'eligible',
        Address: '10.0.0.5',
        Version: '1.8.0',
        Drivers: { docker: { Detected: true, Healthy: true } },
      }),
    ).toMatchObject({ ID: 'node-1', Version: '1.8.0' });
    expect(
      NomadNodeDetailSchema.parse({
        ID: 'node-1',
        Name: 'client-a',
        Status: 'ready',
        SchedulingEligibility: 'eligible',
        HTTPAddr: '10.0.0.5:4646',
        Attributes: { 'nomad.version': '1.8.0' },
        Meta: { rack: 'r1' },
      }),
    ).toMatchObject({ Meta: { rack: 'r1' } });
  });

  it('rejects a node stub missing SchedulingEligibility', () => {
    expect(
      NomadNodeStubSchema.safeParse({ ID: 'n', Name: 'x', Status: 'ready' }).success,
    ).toBe(false);
  });
});

describe('NomadJobSummarySchema', () => {
  it('accepts a job summary with nullable TaskGroups', () => {
    expect(
      NomadJobSummarySchema.parse({
        Status: 'running',
        Version: 2,
        TaskGroups: [{ Name: 'bridge', Tasks: [{ Name: 'app' }] }],
      }),
    ).toMatchObject({ Version: 2 });
  });

  it('rejects TaskGroups entries without Name', () => {
    expect(
      NomadJobSummarySchema.safeParse({
        TaskGroups: [{ Tasks: [{ Name: 'app' }] }],
      }).success,
    ).toBe(false);
  });
});
