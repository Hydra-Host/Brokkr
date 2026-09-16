import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Run, RunSection } from '../../contract';
import { RunCapabilityGuard, runCapability } from '../run-capability.guard';
import { RunsService } from '../runs.service';

const REMOTE = '10.0.0.5';

afterEach(() => {
  vi.unstubAllEnvs();
});

function run(over: Partial<Run> = {}): Run {
  return {
    runId: 'r1',
    section: 'fleet',
    opId: 'power',
    label: 'power cn1 on',
    status: 'running',
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    nodeIndex: null,
    origin: null,
    hasLog: false,
    hasResult: false,
    ...over,
  };
}

function guardFor(get: () => Run): RunCapabilityGuard {
  const runs: RunsService = Object.assign(Object.create(RunsService.prototype), { get });
  return new RunCapabilityGuard(runs);
}

function contextFor(peer: string, headers: Record<string, string> = {}) {
  const req = { params: { runId: 'r1' }, ip: peer, socket: { remoteAddress: peer }, headers, query: {} };
  return new ExecutionContextHost([req], class {}, () => undefined);
}

describe('runCapability', () => {
  it('prices a stack run at admin and every other section at operate', () => {
    expect(runCapability(run({ section: 'stack', opId: 'redeploy' }))).toBe('admin');
    for (const section of ['fleet', 'build', 'storage', 'test', 'queues'] satisfies RunSection[]) {
      expect(runCapability(run({ section }))).toBe('operate');
    }
  });
});

describe('RunCapabilityGuard', () => {
  it('admits a loopback caller', () => {
    expect(guardFor(() => run({ section: 'stack' })).canActivate(contextFor('127.0.0.1'))).toBe(true);
  });

  it('admits the api token on a run its capability covers', () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    const ctx = contextFor(REMOTE, { authorization: 'Bearer api-token' });
    expect(guardFor(() => run({ section: 'stack' })).canActivate(ctx)).toBe(true);
  });

  it('refuses a remote caller holding no token', () => {
    expect(() => guardFor(() => run()).canActivate(contextFor(REMOTE))).toThrow(ForbiddenException);
  });

  it('surfaces the ledger lookup failure for an unknown run', () => {
    const guard = guardFor(() => {
      throw new NotFoundException("unknown run 'r1'");
    });
    expect(() => guard.canActivate(contextFor('127.0.0.1'))).toThrow(NotFoundException);
  });
});
