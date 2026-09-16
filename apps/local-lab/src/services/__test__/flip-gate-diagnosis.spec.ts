import { describe, expect, it } from 'vitest';

import { diagnoseGateTimeout } from '../flip-gate-diagnosis';
import type { PcProcess } from '../proc-health';

const procs: PcProcess[] = [
  { name: 'spoke', status: 'Running', is_ready: 'Not Ready' },
  { name: 'hub-api', status: 'Skipped', is_ready: '-' },
];

describe('diagnoseGateTimeout', () => {
  it('names each process with its status, readiness and the last log line', () => {
    const text = diagnoseGateTimeout(['spoke', 'hub-api'], procs, () => 'last line');

    expect(text).toContain('spoke: Running / Not Ready');
    expect(text).toContain('hub-api: Skipped / -');
    expect(text).toContain('last line');
  });

  it('attaches the Redeploy remedy only to a Skipped process', () => {
    const lines = diagnoseGateTimeout(['spoke', 'hub-api'], procs, () => undefined).split('\n');

    expect(lines[0]).not.toContain('only a dependency transition clears Skipped — run Redeploy');
    expect(lines[1]).toContain('only a dependency transition clears Skipped — run Redeploy');
  });

  it('carries the restart and exit counters into the line', () => {
    const text = diagnoseGateTimeout(
      ['hub-api'],
      [{ name: 'hub-api', status: 'Completed', is_ready: '-', restarts: 4, exit_code: 1 }],
      () => undefined,
    );

    expect(text).toBe('hub-api: Completed / - (restarts 4, exit 1, failed)');
  });

  it('reports a process the roster does not list as absent', () => {
    expect(diagnoseGateTimeout(['ghost'], procs, () => 'noise')).toBe('ghost: absent from process-compose');
  });

  it('omits the log line when the tail has nothing', () => {
    expect(diagnoseGateTimeout(['spoke'], procs, () => undefined).split('\n')).toHaveLength(1);
  });
});
