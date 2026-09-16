import { describe, expect, it, vi } from 'vitest';

import { RunnerService, type RunState } from '../../runner/runner.service';
import { OverlayStoreService } from '../../services/overlay-store';
import { RepoBranchService } from '../../services/repo-branch.service';
import { BuildService } from '../build.service';

function makeService(uplink: { iface: string; ip: string } | null) {
  const run: RunState = {
    runId: 'r1',
    section: 'build',
    opId: 'build-ipxe',
    label: 'iPXE',
    status: 'running',
    startedAt: 1,
    exitCode: null,
    log$: { next: vi.fn(), complete: vi.fn() } as never,
    lines: [],
    bytes: 0,
  };
  const runner = {
    create: vi.fn(() => run),
    emit: vi.fn(),
    finalize: vi.fn(),
    spawn: vi.fn((_run: RunState, _cmd: string, _args: string[]) => Promise.resolve(0)),
  };
  const overlay = { bmUplink: vi.fn(() => uplink) };
  const repoBranch = { repoPath: vi.fn(() => undefined) };
  const svc = new BuildService(
    runner as unknown as RunnerService,
    overlay as unknown as OverlayStoreService,
    repoBranch as unknown as RepoBranchService,
  );
  return { svc, runner, overlay, repoBranch };
}

describe('BuildService.buildIpxe — the chain URL follows the uplink', () => {
  it('passes --chain-base-url (uplink IP + spoke base port) when a bare-metal uplink is bound', () => {
    const { svc, runner } = makeService({ iface: 'eth0', ip: '10.0.0.5' });

    svc.buildIpxe();

    const args = runner.spawn.mock.calls[0][2];
    expect(args).toEqual(['-m', 'local.ipxe_build', '--force', '--chain-base-url', 'http://10.0.0.5:8000']);
  });

  it('passes only --force without an uplink', () => {
    const { svc, runner } = makeService(null);

    svc.buildIpxe();

    const args = runner.spawn.mock.calls[0][2];
    expect(args).toEqual(['-m', 'local.ipxe_build', '--force']);
    expect(args).not.toContain('--chain-base-url');
  });
});
