import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hubApiFetch, hubApiSignIn } from '../../common/hub-client';
import { RunnerService, type RunState } from '../../runner/runner.service';
import { FleetResetService } from '../fleet-reset.service';

vi.mock('../../common/sleep', () => ({ sleep: () => Promise.resolve() }));
vi.mock('../../common/hub-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/hub-client')>();
  return { ...actual, hubApiSignIn: vi.fn(() => Promise.resolve(new Map())), hubApiFetch: vi.fn() };
});

function makeService(deadlineMs?: number) {
  const run: RunState = {
    runId: 'discover-run',
    section: 'fleet',
    opId: 'discover',
    label: 'discover',
    status: 'running',
    startedAt: 1,
    exitCode: null,
    log$: new Subject<string>(),
    lines: [],
    bytes: 0,
    nodeIndex: null,
  };
  const runner = {
    create: vi.fn(() => run),
    emit: vi.fn((r: RunState, text: string) => {
      r.lines.push(text);
    }),
    finalize: vi.fn((r: RunState, code: number | null) => {
      if (r.status !== 'running') return;
      r.exitCode = code;
      r.status = code === 0 ? 'passed' : 'failed';
    }),
  };
  const topology = { nodeNames: vi.fn(() => ['cpu-1', 'cpu-2']) };
  const svc = new FleetResetService(
    runner as unknown as RunnerService,
    {} as never,
    topology as never,
    {} as never,
    {} as never,
    {} as never,
  );
  if (deadlineMs !== undefined) Object.assign(svc, { discoverDeadlineMs: deadlineMs });
  return { svc, runner, run };
}

afterEach(() => vi.clearAllMocks());

describe('FleetResetService.discoverNative', () => {
  it('finalizes with exit 1 and a FAILED log when discovery times out without a signature change', async () => {
    const { svc, runner, run } = makeService(0);
    vi.mocked(hubApiSignIn).mockResolvedValue(new Map());
    vi.mocked(hubApiFetch).mockImplementation((_base, _jar, method) =>
      method === 'POST'
        ? Promise.resolve({ code: 200, body: { jobId: 'job-1' } })
        : Promise.resolve({ code: 200, body: { storageLayouts: { configs: [] } } }),
    );

    svc.discoverNative(0);

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 1));
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.lines.join('')).toContain('FAILED');
  });

  it('finalizes with exit 0 when a poll shows the storageLayouts signature changed', async () => {
    const { svc, runner, run } = makeService();
    vi.mocked(hubApiSignIn).mockResolvedValue(new Map());
    const getResponses = [
      { code: 200, body: { storageLayouts: { configs: [{ disk_group_name: 'SSD', disks: [{}, {}] }] } } },
      { code: 200, body: { storageLayouts: { configs: [{ disk_group_name: 'SSD', disks: [{}, {}, {}] }] } } },
    ];
    vi.mocked(hubApiFetch).mockImplementation((_base, _jar, method) =>
      method === 'POST'
        ? Promise.resolve({ code: 200, body: { jobId: 'job-1' } })
        : Promise.resolve(getResponses.shift() ?? { code: 200, body: { storageLayouts: { configs: [] } } }),
    );

    svc.discoverNative(0);

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    expect(run.status).toBe('passed');
    expect(run.lines.join('')).toContain('discovery landed');
  });

  it('warns exactly once across repeated unparsable polls and treats storageLayouts as empty', async () => {
    const { svc, runner, run } = makeService(60_000);
    vi.mocked(hubApiSignIn).mockResolvedValue(new Map());
    const unparsable = { code: 200, body: { storageLayouts: { configs: 'not-an-array' } } };
    const changed = { code: 200, body: { storageLayouts: { configs: [{ disk_group_name: 'SSD', disks: [{}, {}] }] } } };
    const getResponses = [unparsable, unparsable, changed];
    vi.mocked(hubApiFetch).mockImplementation((_base, _jar, method) =>
      method === 'POST'
        ? Promise.resolve({ code: 200, body: { jobId: 'job-1' } })
        : Promise.resolve(getResponses.shift() ?? changed),
    );

    svc.discoverNative(0);

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    const warnLines = run.lines.filter((l) => l.includes("hub server payload didn't parse"));
    expect(warnLines).toHaveLength(1);
    expect(run.lines.join('')).toContain('storageLayouts has 0 disk(s)');
  });

  it('treats a non-200 server response as an empty signature without warning', async () => {
    const { svc, runner, run } = makeService(60_000);
    vi.mocked(hubApiSignIn).mockResolvedValue(new Map());
    const getResponses = [
      { code: 500, body: null },
      { code: 200, body: { storageLayouts: { configs: [{ disk_group_name: 'SSD', disks: [{}] }] } } },
    ];
    vi.mocked(hubApiFetch).mockImplementation((_base, _jar, method) =>
      method === 'POST'
        ? Promise.resolve({ code: 200, body: { jobId: 'job-1' } })
        : Promise.resolve(getResponses.shift() ?? { code: 500, body: null }),
    );

    svc.discoverNative(0);

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    expect(run.lines.filter((l) => l.includes("hub server payload didn't parse"))).toHaveLength(0);
    expect(run.lines.join('')).toContain('storageLayouts has 0 disk(s)');
  });
});
