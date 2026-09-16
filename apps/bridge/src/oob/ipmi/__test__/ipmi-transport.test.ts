import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnRecord {
  args: unknown[];
}

const STDOUT_TRUNCATE = 1_000_000;
const STDERR_TRUNCATE = 10_000;

interface SpawnConfig {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: Error;
  hang?: boolean;
}

const spawnRecords: SpawnRecord[] = [];
let nextSpawnConfig: SpawnConfig = {
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
};
let spawnQueue: SpawnConfig[] = [];

class FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed = false;
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill(_signal?: string): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

vi.mock('node:child_process', () => {
  return {
    spawn: (...args: unknown[]): ChildProcess => {
      spawnRecords.push({ args });
      const child = new FakeChild();
      const config = spawnQueue.shift() ?? nextSpawnConfig;
      if (config.error) {
        setImmediate(() => child.emit('error', config.error));
        setImmediate(() => child.emit('close', null));
        return child as unknown as ChildProcess;
      }
      if (config.hang) {
        return child as unknown as ChildProcess;
      }
      setImmediate(() => {
        if (config.stdout.length > 0) child.stdout.emit('data', config.stdout);
        if (config.stderr.length > 0) child.stderr.emit('data', config.stderr);
        child.emit('close', config.exitCode);
      });
      return child as unknown as ChildProcess;
    },
  };
});

let run: typeof import('../transport.js').run;

beforeEach(async () => {
  spawnRecords.length = 0;
  spawnQueue = [];
  nextSpawnConfig = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  ({ run } = await import('../transport.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transport.run — success and failure', () => {
  it('returns ok=true and trimmed stdout on exit 0', async () => {
    nextSpawnConfig = { exitCode: 0, stdout: Buffer.from('Chassis Power is on\n'), stderr: Buffer.alloc(0) };
    const result = await run(['/usr/bin/ipmitool', 'power', 'status'], 'pw', 5);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('Chassis Power is on');
    expect(result.stderr).toBe('');
    expect(result.returncode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr on non-zero exit', async () => {
    nextSpawnConfig = { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Unable to establish session\n') };
    const result = await run(['/usr/bin/ipmitool', 'power', 'status'], 'pw', 5);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('Unable to establish session');
    expect(result.returncode).toBe(1);
  });

  it('forwards cipherUsed onto the result', async () => {
    nextSpawnConfig = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const result = await run(['/usr/bin/ipmitool'], 'pw', 5, { cipherUsed: '17' });
    expect(result.cipherUsed).toBe('17');
  });
});

describe('transport.run — timeout handling', () => {
  it('synthesizes a timeout result when the child outlives the deadline', async () => {
    vi.useFakeTimers();
    nextSpawnConfig = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), hang: true };
    const pending = run(['/usr/bin/ipmitool'], 'pw', 1);
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.returncode).toBeNull();
    expect(result.stderr).toBe('Command timed out');
  });
});

describe('transport.run — unexpected spawn failure', () => {
  it('maps spawn errors to ok=false with stderr="Internal error"', async () => {
    nextSpawnConfig = { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: new Error('boom') };
    const result = await run(['/usr/bin/ipmitool'], 'pw', 1);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe('Internal error');
  });
});

describe('transport.run — truncation', () => {
  it('truncates long stdout', async () => {
    const long = Buffer.from('x'.repeat(STDOUT_TRUNCATE + 100));
    nextSpawnConfig = { exitCode: 0, stdout: long, stderr: Buffer.alloc(0) };
    const result = await run(['/usr/bin/ipmitool'], 'pw', 5);
    expect(result.stdout.length).toBeLessThanOrEqual(STDOUT_TRUNCATE + '\n... (truncated)'.length);
    expect(result.stdout.endsWith('(truncated)')).toBe(true);
  });

  it('truncates long stderr', async () => {
    const long = Buffer.from('e'.repeat(STDERR_TRUNCATE + 100));
    nextSpawnConfig = { exitCode: 2, stdout: Buffer.alloc(0), stderr: long };
    const result = await run(['/usr/bin/ipmitool'], 'pw', 5);
    expect(result.stderr.length).toBeLessThanOrEqual(STDERR_TRUNCATE + '\n... (truncated)'.length);
    expect(result.stderr.endsWith('(truncated)')).toBe(true);
  });
});

describe('transport.run — argv wrapping', () => {
  it('wraps argv with `timeout --preserve-status Ns` followed by the original command', async () => {
    nextSpawnConfig = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    await run(['/usr/bin/ipmitool', 'power', 'status'], 'pw', 7);
    expect(spawnRecords.length).toBeGreaterThan(0);
    const record = spawnRecords[0];
    if (!record) throw new Error('expected a spawn record');
    const [bin, args] = record.args as [string, string[]];
    expect(bin).toBe('timeout');
    expect(args[0]).toBe('--preserve-status');
    expect(args[1]).toBe('7s');
    expect(args[2]).toBe('/usr/bin/ipmitool');
  });
});

describe('transport.run — duration', () => {
  it.each([1, 5, 30])('records a non-negative durationMs (timeout=%i)', async (timeout) => {
    nextSpawnConfig = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const result = await run(['/usr/bin/ipmitool'], 'pw', timeout);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

const DENIED_STDERR = Buffer.from(
  'RAKP 2 message indicates an error : unauthorized role requested\nError: Unable to establish IPMI v2 / RMCP+ session\n',
);

function failWith(stderr: Buffer): SpawnConfig {
  return { exitCode: 1, stdout: Buffer.alloc(0), stderr };
}

function succeedWith(stdout: Buffer): SpawnConfig {
  return { exitCode: 0, stdout, stderr: Buffer.alloc(0) };
}

function spawnArgv(index: number): string[] {
  const record = spawnRecords[index];
  if (!record) throw new Error(`expected a spawn record at ${index}`);
  return record.args[1] as string[];
}

describe('transport.run — privilege fallback', () => {
  it('retries once with -L OPERATOR when ADMINISTRATOR is refused', async () => {
    spawnQueue = [failWith(DENIED_STDERR), succeedWith(Buffer.from('Chassis Power is on\n'))];
    const result = await run(['/usr/bin/ipmitool', '-H', '10.0.0.1', 'power', 'status'], 'pw', 5);

    expect(spawnRecords).toHaveLength(2);
    expect(spawnArgv(0)).not.toContain('-L');
    expect(spawnArgv(1).slice(2, 5)).toEqual(['/usr/bin/ipmitool', '-L', 'OPERATOR']);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('Chassis Power is on');
  });

  it('reports the fallback argv on the result', async () => {
    spawnQueue = [failWith(DENIED_STDERR), succeedWith(Buffer.alloc(0))];
    const result = await run(['/usr/bin/ipmitool', 'power', 'status'], 'pw', 5);

    expect(result.command).toEqual(['/usr/bin/ipmitool', '-L', 'OPERATOR', 'power', 'status']);
  });

  it('does not loop when the OPERATOR retry is refused too', async () => {
    spawnQueue = [failWith(DENIED_STDERR), failWith(DENIED_STDERR)];
    const result = await run(['/usr/bin/ipmitool', 'power', 'status'], 'pw', 5);

    expect(spawnRecords).toHaveLength(2);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['generic session failure', 'Error: Unable to establish IPMI v2 / RMCP+ session\n'],
    ['a command needing more privilege', 'Insufficient privilege level\n'],
    ['a refusal already at OPERATOR', 'Set Session Privilege Level to OPERATOR failed\n'],
    ['no stderr at all', ''],
  ])('does not retry on %s', async (_label, stderr) => {
    spawnQueue = [failWith(Buffer.from(stderr)), succeedWith(Buffer.alloc(0))];
    const result = await run(['/usr/bin/ipmitool', 'power', 'cycle'], 'pw', 5);

    expect(spawnRecords).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it('does not retry a successful call', async () => {
    spawnQueue = [succeedWith(Buffer.from('ok\n'))];
    await run(['/usr/bin/ipmitool', 'power', 'status'], 'pw', 5);

    expect(spawnRecords).toHaveLength(1);
  });

  it('honours allowPrivilegeFallback: false', async () => {
    spawnQueue = [failWith(DENIED_STDERR), succeedWith(Buffer.alloc(0))];
    const result = await run(['/usr/bin/ipmitool', '-I', 'lanplus', 'chassis', 'status'], 'pw', 5, {
      allowPrivilegeFallback: false,
    });

    expect(spawnRecords).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it('leaves an explicitly pinned privilege level alone', async () => {
    spawnQueue = [failWith(DENIED_STDERR), succeedWith(Buffer.alloc(0))];
    await run(['/usr/bin/ipmitool', '-L', 'USER', 'power', 'status'], 'pw', 5);

    expect(spawnRecords).toHaveLength(1);
  });

  it('does not retry a timed-out call', async () => {
    vi.useFakeTimers();
    nextSpawnConfig = { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), hang: true };
    const promise = run(['/usr/bin/ipmitool', 'power', 'status'], 'pw', 1);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(spawnRecords).toHaveLength(1);
    expect(result.timedOut).toBe(true);
  });
});
