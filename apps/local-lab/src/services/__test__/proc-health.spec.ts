import { classifyProc, CRASHLOOP_RESTARTS, depsReady, procIsUp, type PcProcess } from '../proc-health';


const proc = (over: Partial<PcProcess>): PcProcess => ({ name: 'x', status: 'Running', ...over });
const byName = (ps: PcProcess[]) => new Map(ps.map((p) => [p.name, p]));

describe('procIsUp', () => {
  it('is up when Running and Ready, or Running with a probe-less "-"', () => {
    expect(procIsUp(proc({ status: 'Running', is_ready: 'Ready' }))).toBe(true);
    expect(procIsUp(proc({ status: 'Running', is_ready: '-' }))).toBe(true);
  });

  it('is not up when Not Ready, stopped, or absent', () => {
    expect(procIsUp(proc({ status: 'Running', is_ready: 'Not Ready' }))).toBe(false);
    expect(procIsUp(proc({ status: 'Completed', is_ready: 'Ready' }))).toBe(false);
    expect(procIsUp(undefined)).toBe(false);
  });
});

describe('classifyProc', () => {
  it('classifies running states (up / unhealthy / crashlooping)', () => {
    expect(classifyProc(proc({ status: 'Running', is_ready: 'Ready' }), true).status).toBe('up');
    expect(classifyProc(proc({ status: 'Running', is_ready: 'Not Ready', restarts: 0 }), true).status).toBe(
      'unhealthy',
    );
    expect(
      classifyProc(proc({ status: 'Running', is_ready: 'Not Ready', restarts: CRASHLOOP_RESTARTS }), true).status,
    ).toBe('crashlooping');
  });

  it('treats a probe-less Running row ("-"/absent) as up, matching procIsUp', () => {
    expect(classifyProc(proc({ status: 'Running', is_ready: '-' }), true).status).toBe('up');
    expect(classifyProc(proc({ status: 'Running', is_ready: undefined }), true).status).toBe('up');
  });

  it('marks a stopped process with a down dependency as blocked, before any failure reason', () => {
    expect(classifyProc(proc({ status: 'Completed', exit_code: 0 }), false).status).toBe('blocked');
    expect(classifyProc(proc({ status: 'Error' }), false).status).toBe('blocked');
  });

  it('distinguishes terminal failures from a clean stop', () => {
    expect(classifyProc(proc({ status: 'Error' }), true).status).toBe('failed');
    expect(classifyProc(proc({ status: 'Completed', exit_code: 1 }), true).status).toBe('failed');
    expect(classifyProc(proc({ status: 'Completed', restarts: CRASHLOOP_RESTARTS }), true).status).toBe('failed');
    expect(classifyProc(proc({ status: 'Completed', exit_code: 0, restarts: 0 }), true).status).toBe('down');
  });

  it('treats a termination-signal exit (SIGINT/SIGKILL/SIGTERM) as a clean stop, not a failure', () => {
    expect(classifyProc(proc({ status: 'Completed', exit_code: 143 }), true).status).toBe('down');
    expect(classifyProc(proc({ status: 'Stopped', exit_code: 143 }), true).status).toBe('down');
    expect(classifyProc(proc({ status: 'Completed', exit_code: 130 }), true).status).toBe('down');
    expect(classifyProc(proc({ status: 'Completed', exit_code: 137 }), true).status).toBe('down');
  });

  it('treats disabled as intentional and an absent process as missing', () => {
    expect(classifyProc(proc({ status: 'Disabled' }), true).status).toBe('disabled');
    expect(classifyProc(undefined, true).status).toBe('missing');
  });

  it('surfaces raw signals and a human "why" detail', () => {
    const d = classifyProc(proc({ status: 'Completed', exit_code: 2, restarts: 1 }), true);
    expect(d.status).toBe('failed');
    expect(d.exitCode).toBe(2);
    expect(d.restarts).toBe(1);
    expect(d.detail).toMatch(/exited 2/);
  });
});

describe('depsReady', () => {
  const graph = { 'hub-api': ['redis'], spoke: ['redis'] };

  it('blocks on a down real dependency but not on up / disabled / unknown / no-deps', () => {
    expect(depsReady('hub-api', byName([proc({ name: 'redis', status: 'Running', is_ready: 'Ready' })]), graph)).toBe(
      true,
    );
    expect(depsReady('hub-api', byName([proc({ name: 'redis', status: 'Completed' })]), graph)).toBe(false);
    expect(depsReady('hub-api', byName([proc({ name: 'redis', status: 'Disabled' })]), graph)).toBe(true);
    expect(depsReady('hub-api', byName([]), graph)).toBe(true);
    expect(depsReady('redis', byName([]), graph)).toBe(true);
  });
});
