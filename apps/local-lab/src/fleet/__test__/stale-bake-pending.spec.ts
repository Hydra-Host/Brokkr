import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const BM_ONLY: FleetPlanes = { vm: false, baremetal: true };

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

const UPLINK_IP = '198.51.100.14';
const SPOKE_PORT = '8123';
const EXPECTED = `http://${UPLINK_IP}:${SPOKE_PORT}`;

describe('FleetTopologyService.pending — stale iPXE bake', () => {
  let stateDir: string;
  let buildsDir: string;

  const applied = (planes: FleetPlanes): void => {
    mkdirSync(join(stateDir, 'state/run'), { recursive: true });
    const manifest = { nodes: planes.vm ? [{ name: 'cpu-1' }] : [], bmNodes: planes.baremetal ? [{ name: 'bm-1' }] : [] };
    writeFileSync(join(stateDir, 'state/run/fleet-applied.json'), JSON.stringify(manifest));
  };

  const stamp = (chainBaseUrl: string): void =>
    writeFileSync(join(buildsDir, '.chain-stamp.json'), JSON.stringify({ chain_base_url: chainBaseUrl, built_at: 1 }));

  const svc = (planes: FleetPlanes, uplink: { iface: string; ip: string } | null) => {
    applied(planes);
    return new FleetTopologyService(
      { repoRoot: '/repo' } as never,
      { planes: () => planes, bmUplink: () => uplink } as never,
      { renderDesiredFleetYaml: () => Promise.resolve('/repo/fleet.yml') } as never,
    );
  };

  const bareMetal = () => svc(BM_ONLY, { iface: 'eth0', ip: UPLINK_IP });

  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: IN_SYNC, stderr: '' }),
    );
    stateDir = mkdtempSync(join(tmpdir(), 'lab-stale-bake-state-'));
    buildsDir = mkdtempSync(join(tmpdir(), 'lab-stale-bake-builds-'));
    vi.stubEnv('LOCAL_STATE', stateDir);
    vi.stubEnv('LOCAL_IPXE_BUILDS_DIR', buildsDir);
    vi.stubEnv('SPOKE_PORT_BASE', SPOKE_PORT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(buildsDir, { recursive: true, force: true });
  });

  it('leaves a vm-only fleet alone whatever the stamp says', async () => {
    stamp('http://203.0.113.7:9999');
    const p = await svc(VM_ONLY, null).pending();

    expect(p.severity).toBe('in-sync');
    expect(p.inSync).toBe(true);
  });

  it('stays in sync with a bare-metal plane when the stamp matches the served chain url', async () => {
    stamp(EXPECTED);
    const p = await bareMetal().pending();

    expect(p.severity).toBe('in-sync');
    expect(p.inSync).toBe(true);
  });

  it('reports stale-bake and not in sync when no bake has run at all', async () => {
    const p = await bareMetal().pending();

    expect(p.severity).toBe('stale-bake');
    expect(p.inSync).toBe(false);
    expect(p.note).toContain(EXPECTED);
  });

  it('reports stale-bake naming both urls when the stamp names another host', async () => {
    stamp('http://198.51.100.9:8123');
    const p = await bareMetal().pending();

    expect(p.severity).toBe('stale-bake');
    expect(p.inSync).toBe(false);
    expect(p.note).toContain('http://198.51.100.9:8123');
    expect(p.note).toContain(EXPECTED);
  });

  it('keeps a pending rebuild severity and adds the bake to its note', async () => {
    const rebuild = JSON.stringify({
      inSync: false,
      severity: 'needs-full-rebuild',
      desiredDigest: 'sha256:a',
      appliedDigest: 'sha256:b',
      appliedAt: 1,
      summary: { added: 1, removed: 0, changed: 0, unchanged: 0 },
      nodes: { added: [], removed: [], changed: [] },
      network: { changed: false, fields: [] },
      note: null,
    });
    execFileMock.mockImplementation((_c: unknown, _a: unknown, _o: unknown, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: rebuild, stderr: '' }),
    );

    const p = await bareMetal().pending();

    expect(p.severity).toBe('needs-full-rebuild');
    expect(p.inSync).toBe(false);
    expect(p.note).toContain(EXPECTED);
  });

  it('reports stale-bake when only the port differs', async () => {
    stamp(`http://${UPLINK_IP}:8000`);
    const p = await bareMetal().pending();

    expect(p.severity).toBe('stale-bake');
    expect(p.inSync).toBe(false);
    expect(p.note).toContain(`http://${UPLINK_IP}:8000`);
  });
});
