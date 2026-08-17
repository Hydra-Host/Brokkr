import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnRecord {
  args: unknown[];
}

const STDOUT_TRUNCATE = 1_000_000;
const STDERR_TRUNCATE = 10_000;

const spawnRecords: SpawnRecord[] = [];
let nextSpawnConfig: {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: Error;
  hang?: boolean;
} = {
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
};

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
      const config = nextSpawnConfig;
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
