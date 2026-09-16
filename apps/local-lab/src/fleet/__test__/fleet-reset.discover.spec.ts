import { NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bmDeviceUuid, hubApiFetch, hubApiSignIn } from '../../common/hub-client';
import { RunnerService, type RunState } from '../../runner/runner.service';
import { FleetResetService } from '../fleet-reset.service';
import { resolveRoster, type RosterNode } from '../fleet-roster';

vi.mock('../../common/sleep', () => ({ sleep: () => Promise.resolve() }));
vi.mock('../../common/hub-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/hub-client')>();
  return { ...actual, hubApiSignIn: vi.fn(() => Promise.resolve(new Map())), hubApiFetch: vi.fn() };
});

const VM_ROSTER = resolveRoster({ vmNodeNames: () => ['cpu-1', 'cpu-2'], baremetalNodes: () => [] });
const BM_ROSTER = resolveRoster({
  vmNodeNames: () => [],
  baremetalNodes: () => [
    {
      name: 'metal-1',
      bmc_ip: '10.10.0.5',
      bmc_mac: 'aa:bb:cc:dd:ee:01',
      pxe_mac: '00:00:5e:00:53:b1',
      arch: null,
      system_id: null,
    },
  ],
});

function makeService(deadlineMs?: number, roster: RosterNode[] = VM_ROSTER) {
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
  const lease = { key: 'node', bind: vi.fn(), release: vi.fn() };
  const svc = new FleetResetService(
    runner as unknown as RunnerService,
    {} as never,
    { roster: () => roster } as never,
    { acquire: vi.fn(() => lease) } as never,
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

    svc.discoverNative(VM_ROSTER[0]);

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

    svc.discoverNative(VM_ROSTER[0]);

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

    svc.discoverNative(VM_ROSTER[0]);

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

    svc.discoverNative(VM_ROSTER[0]);

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    expect(run.lines.filter((l) => l.includes("hub server payload didn't parse"))).toHaveLength(0);
    expect(run.lines.join('')).toContain('storageLayouts has 0 disk(s)');
  });
});

describe('FleetResetService.discover by roster node', () => {
  it('posts the pxe-derived device id when discovering a bare-metal machine', async () => {
    const { svc, runner } = makeService(0, BM_ROSTER);
    vi.mocked(hubApiSignIn).mockResolvedValue(new Map());
    vi.mocked(hubApiFetch).mockImplementation((_base, _jar, method) =>
      method === 'POST'
        ? Promise.resolve({ code: 200, body: { jobId: 'job-1' } })
        : Promise.resolve({ code: 200, body: { storageLayouts: { configs: [] } } }),
    );

    svc.discover('metal-1');

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    const post = vi.mocked(hubApiFetch).mock.calls.find(([, , method]) => method === 'POST');
    expect(post?.[3]).toBe(`/api/v1/servers/${bmDeviceUuid('00:00:5e:00:53:b1')}/collect-inventory`);
  });

  it('rejects an unknown machine name with 404 before creating a run', () => {
    const { svc, runner } = makeService(0, BM_ROSTER);

    expect(() => svc.discover('ghost')).toThrow(NotFoundException);
    expect(runner.create).not.toHaveBeenCalled();
  });
});
