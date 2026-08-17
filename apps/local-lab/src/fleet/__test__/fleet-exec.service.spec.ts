import { EventEmitter } from 'node:events';

import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetExecService } from '../fleet-exec.service';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function makeService() {
  const svc = new FleetExecService({
    dataIpForNode: (name: string) => {
      if (name === 'cpu-1') return '10.0.0.5';
      throw new NotFoundException(`unknown node '${name}'`);
    },
  } as never);
  vi.spyOn(svc as unknown as { sshPrivKeyPath: () => string }, 'sshPrivKeyPath').mockReturnValue('/home/op/.ssh/id');
  return svc;
}

describe('FleetExecService.runOnNode', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('rejects an unknown node before spawning anything', async () => {
    const svc = makeService();
    await expect(svc.runOnNode('nope', 'ls')).rejects.toBeInstanceOf(NotFoundException);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('maps a transport/connection error to exit_code 255', async () => {
    const svc = makeService();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = svc.runOnNode('cpu-1', 'ls');
    child.emit('error', new Error('ssh: connect to host failed'));
    const res = await p;
    expect(res.exit_code).toBe(255);
    expect(res.stderr).toContain('connect to host failed');
  });

  it('returns the child exit code on normal close and captures stdout', async () => {
    const svc = makeService();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = svc.runOnNode('cpu-1', 'echo hi');
    child.stdout.emit('data', Buffer.from('hello'));
    child.emit('close', 0);
    expect(await p).toMatchObject({ exit_code: 0, stdout: 'hello' });
  });

  it('maps a null close code to 255', async () => {
    const svc = makeService();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = svc.runOnNode('cpu-1', 'x');
    child.emit('close', null);
    expect((await p).exit_code).toBe(255);
  });

  it('times out to exit_code 124 and SIGKILLs after timeoutS + 5s grace', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = svc.runOnNode('cpu-1', 'sleep 999', 'root', 30);
    await vi.advanceTimersByTimeAsync(35_000);
    const res = await p;
    expect(res.exit_code).toBe(124);
    expect(res.stderr).toContain('lab-side timeout after 35s');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('truncates captured output to 1 MiB', async () => {
    const svc = makeService();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = svc.runOnNode('cpu-1', 'cat big');
    child.stdout.emit('data', Buffer.alloc(2 * 1_048_576, 0x61));
    child.emit('close', 0);
    expect((await p).stdout.length).toBe(1_048_576);
  });

  it('normalizes an empty/whitespace user to root and passes the command as one verbatim argv element', async () => {
    const svc = makeService();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = svc.runOnNode('cpu-1', 'whoami && id', '   ');
    child.emit('close', 0);
    await p;
    const [cmd, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('ssh');
    expect(argv).toContain('root@10.0.0.5');
    expect(argv[argv.length - 1]).toBe('whoami && id');
  });

  it('passes an explicit user through to the ssh target', async () => {
    const svc = makeService();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = svc.runOnNode('cpu-1', 'ls', 'ubuntu');
    child.emit('close', 0);
    await p;
    expect((spawnMock.mock.calls[0] as [string, string[]])[1]).toContain('ubuntu@10.0.0.5');
  });
});
