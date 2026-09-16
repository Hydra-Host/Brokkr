import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...a: unknown[]) => execFileMock(...a),
}));

import type { FleetPlanes } from '@repo/local-lab-contract';

import { FleetTopologyService } from '../fleet-topology.service';

const VM_ONLY: FleetPlanes = { vm: true, baremetal: false };

const IN_SYNC = JSON.stringify({
  inSync: true,
  severity: 'in-sync',
  desiredDigest: 'sha256:x',
  appliedDigest: 'sha256:x',
  appliedAt: 1,
  summary: { added: 0, removed: 0, changed: 0, unchanged: 1 },
  nodes: { added: [], removed: [], changed: [] },
  network: { changed: false, fields: [] },
  note: null,
});

const DRIFT = JSON.stringify({
  inSync: false,
  severity: 'hot-appliable',
  desiredDigest: 'sha256:y',
  appliedDigest: 'sha256:x',
  appliedAt: 1,
  summary: { added: 0, removed: 0, changed: 1, unchanged: 0 },
  nodes: { added: [], removed: [], changed: [] },
  network: { changed: false, fields: [] },
  note: null,
});

function svc(source: string | null = '/repo/fleet.yml', planes: FleetPlanes = VM_ONLY) {
  const runner = { repoRoot: '/repo' };
  const overlay = {
    planes: vi.fn(() => planes),
    bmUplink: vi.fn(() => null),
  };
  const rendered = {
    renderDesiredFleetYaml: vi.fn(() => Promise.resolve(source)),
  };
  return new FleetTopologyService(runner as never, overlay as never, rendered as never);
}

describe('FleetTopologyService.pending', () => {
  let stateDir: string;

  beforeEach(() => {
    execFileMock.mockReset();
    stateDir = mkdtempSync(join(tmpdir(), 'lab-applied-'));
    vi.stubEnv('LOCAL_STATE', stateDir);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('parses the python diff JSON from stdout', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: IN_SYNC, stderr: '' }));
    const p = await svc().pending();
    expect(p.inSync).toBe(true);
  });

  it('reads stdout even when diff exits 2 (drift is not an error)', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) =>
      cb(Object.assign(new Error('exit 2'), { code: 2, stdout: IN_SYNC, stderr: '' })),
    );
    const p = await svc().pending();
    expect(p.severity).toBe('in-sync');
  });

  it('reports a visible degraded state (not in-sync) when diff fails with no usable output', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(new Error('spawn failed')));
    const p = await svc().pending();
    expect(p.inSync).toBe(false);
    expect(p.note).toBeTruthy();
  });

  it('reports degraded (not in-sync) when diff stdout is unparseable', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) =>
      cb(Object.assign(new Error('exit 2'), { code: 2, stdout: 'not json', stderr: '' })),
    );
    const p = await svc().pending();
    expect(p.inSync).toBe(false);
    expect(p.note).toBeTruthy();
  });

  it('degrades (no diff spawn) when the fleet config cannot be refreshed', async () => {
    const p = await svc(null).pending();
    expect(p.inSync).toBe(false);
    expect(p.note).toBeTruthy();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('applyPlan() rejects when the fleet config cannot be refreshed', async () => {
    await expect(svc(null).applyPlan()).rejects.toThrow(/refresh/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('invalidatePending() forces the next poll to recompute (not served from the 2s cache)', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: IN_SYNC, stderr: '' }));
    const s = svc();
    await s.pending();
    await s.pending();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    s.invalidatePending();
    await s.pending();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('stamps planes-change when the saved planes differ from the applied ones', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: IN_SYNC, stderr: '' }));
    const p = await svc('/repo/fleet.yml', { vm: true, baremetal: true }).pending();
    expect(p.severity).toBe('planes-change');
    expect(p.inSync).toBe(false);
  });

  it('stamps planes-change when the last vm node goes with no manifest applied', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: IN_SYNC, stderr: '' }));
    const p = await svc('/repo/fleet.yml', { vm: false, baremetal: true }).pending();
    expect(p.severity).toBe('planes-change');
  });

  it('leaves the engine severity untouched when the planes match (no flip pending)', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: DRIFT, stderr: '' }));
    const p = await svc('/repo/fleet.yml', VM_ONLY).pending();
    expect(p.severity).toBe('hot-appliable');
  });

  it('does not cache a diff that finished after an invalidation (stale-write guard)', async () => {
    let release!: () => void;
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) => {
      release = () => cb(null, { stdout: IN_SYNC, stderr: '' });
    });
    const s = svc();
    const inflight = s.pending();
    await new Promise((r) => setTimeout(r, 0));
    s.invalidatePending();
    release();
    await inflight;
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) => cb(null, { stdout: DRIFT, stderr: '' }));
    const next = await s.pending();
    expect(next.inSync).toBe(false);
  });
});
