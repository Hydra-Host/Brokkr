import { describe, expect, it } from 'vitest';

import type { InitTask, Run, Service, Status } from '@/contract';

import { deriveHero, fleetSummaryLine, footerParts, initSummaryLine, runRoute } from './dashboard-model';

const service = (over: Partial<Service> = {}): Service => ({
  id: 'hub-api',
  label: 'Hub API',
  group: 'hub',
  zone: null,
  port: 3000,
  running: true,
  ready: true,
  pid: 1,
  health: 'up',
  canStop: true,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  runId: 'r1',
  section: 'test',
  opId: 'vitest',
  label: 'vitest e2e',
  status: 'passed',
  startedAt: 1_000,
  finishedAt: 2_000,
  exitCode: 0,
  nodeIndex: null,
  origin: null,
  hasLog: true,
  hasResult: false,
  ...over,
});

const status = (over: Partial<Status> = {}): Status => ({
  app: {
    pid: 1,
    startedAt: 1_000_000,
    uptimeSec: 100,
    memlockLimit: 'unlimited',
    distBuiltAt: 1,
    stale: false,
    ccBuild: { sha: '9fbcfdcde1234', builtAt: 1_500_000, headSha: '9fbcfdcde1234', stale: false },
  },
  repos: {
    lab: { path: '/x', branch: 'main', commit: 'aaa', dirty: false },
    hub: { path: '/x', branch: 'main', commit: 'aaa', dirty: false },
    spoke: { path: '/x', branch: 'main', commit: 'aaa', dirty: false },
  },
  services: [service()],
  datastores: { postgres: true, redis: true },
  stack: { counts: { hub: 1, spoke: 1 }, lifecycleWorkerConcurrency: 4 },
  fleet: [],
  ...over,
});

describe('deriveHero', () => {
  it('renders the control plane ready with probe lines nested in their stages', () => {
    const s = status({
      services: [service(), service({ id: 'spoke', group: 'spoke', zone: 'z1', port: 8000 })],
      hubHealth: {
        target: 'http://localhost:3000/healthcheck',
        ok: true,
        statusCode: 200,
        latencyMs: 41,
        detail: null,
      },
      spokeHealth: [
        { target: 'http://127.0.0.1:8000/api/health', ok: true, statusCode: 200, latencyMs: 38, detail: null },
      ],
    });

    const hero = deriveHero(s);

    expect(hero.line).toEqual({ text: 'control plane ready', failed: false });
    expect(hero.directive).toBe(false);
    const hub = hero.stages.find((st) => st.key === 'hub');
    expect(hub?.sublines).toEqual([{ text: ':3000 http · answering · 41ms', failed: false }]);
    const spoke = hero.stages.find((st) => st.key === 'spoke');
    expect(spoke?.sublines).toEqual([{ text: 'z1 · answering · 38ms', failed: false }]);
  });

  it('flags a wedged http surface on a process the roster reads as up', () => {
    const s = status({
      hubHealth: {
        target: 'http://localhost:3000/healthcheck',
        ok: false,
        statusCode: null,
        latencyMs: null,
        detail: 'timeout after 2000ms',
      },
    });

    const hub = deriveHero(s).stages.find((st) => st.key === 'hub');

    expect(hub?.sublines).toEqual([{ text: ':3000 http · timeout after 2000ms', failed: true }]);
  });

  it('reddens a tier whose process is up but whose http surface does not answer', () => {
    const s = status({
      hubHealth: {
        target: 'http://localhost:3000/healthcheck',
        ok: false,
        statusCode: null,
        latencyMs: null,
        detail: 'timeout after 2000ms',
      },
    });

    const hero = deriveHero(s);

    expect(hero.stages.find((st) => st.key === 'hub')?.state).toBe('failed');
    expect(hero.stages.find((st) => st.key === 'datastores')?.state).toBe('done');
  });

  it('names the unanswering tier in the summary line instead of reading ready', () => {
    const s = status({
      hubHealth: {
        target: 'http://localhost:3000/healthcheck',
        ok: false,
        statusCode: null,
        latencyMs: null,
        detail: 'timeout after 2000ms',
      },
    });

    const hero = deriveHero(s);

    expect(hero.line).toEqual({ text: 'hub up but not answering', failed: true });
    expect(hero.directive).toBe(true);
  });

  it('marks the probe line unavailable rather than failing the stage when the batch is absent', () => {
    const hub = deriveHero(status()).stages.find((st) => st.key === 'hub');

    expect(hub?.sublines).toEqual([{ text: 'hub http · probe unavailable', failed: false }]);
  });

  it('goes directive when a tier fails', () => {
    const hero = deriveHero(status({ datastores: { postgres: false, redis: true } }));

    expect(hero.stack.health).toBe('failed');
    expect(hero.line.failed).toBe(true);
    expect(hero.directive).toBe(true);
    expect(hero.stages.find((st) => st.key === 'datastores')?.sublines[0]).toEqual({
      text: 'pg down · redis up',
      failed: true,
    });
  });

  it('holds coming-up while a stack-section run is in flight instead of flashing failed', () => {
    const hero = deriveHero(
      status({ services: [service({ health: 'failed' })], recentRuns: [run({ status: 'running', section: 'stack' })] }),
    );

    expect(hero.stack.health).toBe('coming-up');
  });

  it('does not let an unrelated run mask a failed control-plane tier', () => {
    const hero = deriveHero(
      status({ services: [service({ health: 'failed' })], recentRuns: [run({ status: 'running' })] }),
    );

    expect(hero.stack.health).toBe('failed');
    expect(hero.directive).toBe(true);
  });

  it('holds a tier short of done while one of its init tasks is still running', () => {
    const tasks: InitTask[] = [
      { name: 'hub:init', label: 'Hub build', state: 'running', exitCode: null, detail: null, updatedAt: 1 },
    ];

    const hub = deriveHero(status(), tasks).stages.find((st) => st.key === 'hub');
    const hubWithoutInit = deriveHero(status()).stages.find((st) => st.key === 'hub');

    expect(hub?.state).toBe('active');
    expect(hubWithoutInit?.state).toBe('done');
  });
});

describe('runRoute', () => {
  it('maps each section to the page that owns it', () => {
    expect(runRoute(run({ section: 'test' }))).toBe('/results');
    expect(runRoute(run({ section: 'fleet' }))).toBe('/fleet');
    expect(runRoute(run({ section: 'storage' }))).toBe('/storage');
    expect(runRoute(run({ section: 'queues' }))).toBe('/datastore');
    expect(runRoute(run({ section: 'stack' }))).toBe('/stack');
    expect(runRoute(run({ section: 'build' }))).toBe('/stack');
  });
});

describe('fleetSummaryLine', () => {
  it('joins the power counts with the lifecycle buckets', () => {
    expect(fleetSummaryLine({ total: 6, on: 4, off: 2, unknown: 0, byLifecycle: { provisioning: 2, failed: 1 } })).toBe(
      '4/6 on · 2 provisioning · 1 failed',
    );
  });
});

describe('footerParts', () => {
  it('carries the build stamp and uptime, leaving init to the strip', () => {
    const parts = footerParts(
      status({ initStatus: { state: 'completed', total: 9, completed: 9, failed: 0, current: null } }),
      2_000_000,
    );

    expect(parts[0]).toBe('cc 9fbcfdc');
    expect(parts.some((p) => p.startsWith('built '))).toBe(true);
    expect(parts.some((p) => p.startsWith('api up '))).toBe(true);
    expect(parts.some((p) => p.startsWith('init '))).toBe(false);
  });

  it('reads a stamp-less dev build as dev', () => {
    const s = status();
    s.app.ccBuild = { sha: null, builtAt: null, headSha: null, stale: false };

    expect(footerParts(s)[0]).toBe('cc dev');
  });
});

describe('initSummaryLine', () => {
  it('names the focus task alongside the count', () => {
    expect(initSummaryLine({ state: 'failed', total: 9, completed: 4, failed: 1, current: 'Sim seed' })).toBe(
      'Sim seed · 4/9 completed',
    );
  });

  it('reads as a bare count when nothing needs attention', () => {
    expect(initSummaryLine({ state: 'completed', total: 9, completed: 9, failed: 0, current: null })).toBe(
      '9/9 completed',
    );
  });
});
