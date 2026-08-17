import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VrrpShimReaderService } from '../vrrp-shim.reader';

let stateDir: string;

const entry = (over: Record<string, unknown> = {}) => ({
  iface: 'eth0',
  local: '10.0.1.1',
  prefixlen: 24,
  label: 'brokkr-vrrp',
  ...over,
});

const write = (instanceId: string, entries: unknown[]) =>
  writeFileSync(join(stateDir, `${instanceId}.json`), JSON.stringify(entries));

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-vrrp-shim-'));
  vi.stubEnv('VRRP_SIM_STATE_DIR', stateDir);
  vi.stubEnv('DEVENV_STATE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('VrrpShimReaderService.bindings', () => {
  it('reports the bridge holding a labelled address, keyed by its state file name', async () => {
    write('spoke', [entry()]);

    expect(await new VrrpShimReaderService().bindings()).toEqual([{ instanceId: 'spoke', cidr: '10.0.1.1/24' }]);
  });

  it('ignores an address the reconciler did not label as its own', async () => {
    write('spoke', [entry({ label: 'secondary' }), entry({ label: undefined })]);

    expect(await new VrrpShimReaderService().bindings()).toEqual([]);
  });

  it('reports an observed empty set when the sim is running but nothing is bound', async () => {
    write('spoke', []);

    expect(await new VrrpShimReaderService().bindings()).toEqual([]);
  });

  it('reports undetermined when the state directory does not exist', async () => {
    rmSync(stateDir, { recursive: true, force: true });

    expect(await new VrrpShimReaderService().bindings()).toBeNull();
  });

  it('reports undetermined when neither the sim dir nor DEVENV_STATE is configured', async () => {
    vi.stubEnv('VRRP_SIM_STATE_DIR', '');

    expect(await new VrrpShimReaderService().bindings()).toBeNull();
  });

  it('falls back to the vrrp-sim directory under DEVENV_STATE when the sim dir is unset', async () => {
    const devenvState = mkdtempSync(join(tmpdir(), 'lab-devenv-state-'));
    mkdirSync(join(devenvState, 'vrrp-sim'));
    writeFileSync(join(devenvState, 'vrrp-sim', 'spoke.json'), JSON.stringify([entry()]));
    vi.stubEnv('VRRP_SIM_STATE_DIR', '');
    vi.stubEnv('DEVENV_STATE', devenvState);

    expect(await new VrrpShimReaderService().bindings()).toEqual([{ instanceId: 'spoke', cidr: '10.0.1.1/24' }]);
    rmSync(devenvState, { recursive: true, force: true });
  });

  it('blinds the whole observation when one bridge state file is unreadable', async () => {
    write('spoke', [entry()]);
    writeFileSync(join(stateDir, 'spoke-2.json'), '{not json');

    expect(await new VrrpShimReaderService().bindings()).toBeNull();
  });

  it('blinds the whole observation when one file does not match the expected shape', async () => {
    write('spoke', [entry()]);
    write('spoke-2', [{ iface: 'eth0' }]);

    expect(await new VrrpShimReaderService().bindings()).toBeNull();
  });
});
