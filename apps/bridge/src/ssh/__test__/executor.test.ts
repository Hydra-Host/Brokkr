import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  execImpl: null as null | ((cmd: string, cb: (err: Error | undefined, stream: unknown) => void) => void),
  lastConnectConfig: null as Record<string, unknown> | null,
  connectError: null as Error | null,
  connectErrors: [] as (Error | null)[],
  connectAttempts: 0,
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');

  class Client extends EventEmitter {
    connect(config: Record<string, unknown>): void {
      harness.lastConnectConfig = config;
      const queued =
        harness.connectErrors.length > 0
          ? harness.connectErrors[Math.min(harness.connectAttempts, harness.connectErrors.length - 1)]
          : harness.connectError;
      harness.connectAttempts += 1;
      if (queued) {
        queueMicrotask(() => this.emit('error', queued));
      } else {
        queueMicrotask(() => this.emit('ready'));
      }
    }
    exec(cmd: string, cb: (err: Error | undefined, stream: unknown) => void): void {
      harness.execImpl?.(cmd, cb);
    }
    end(): void {
      queueMicrotask(() => this.emit('close'));
    }
  }

  return {
    Client,
    utils: {
      parseKey: (raw: string): unknown => {
        if (raw === '__INVALID_KEY__') return new Error('Invalid key');
        return { type: 'ssh-rsa' };
      },
    },
  };
});

const KNOWN_HOST_KEY_B64 = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQDtesthostkeyblob';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const existingPaths = new Set(['/exists/key', '/exists/file.txt', '/bad/key', '/known_hosts', '/known_hosts_ipv6']);
  return {
    ...actual,
    access: vi.fn(async (path: string) => {
      if (existingPaths.has(path)) return undefined;
      if (path.startsWith('/tmp/scp_temp_')) return undefined;
      throw new Error('ENOENT');
    }),
    readFile: vi.fn(async (path: string, _encoding?: string) => {
      if (path === '/exists/key') return 'PRIVATE_KEY_CONTENT';
      if (path === '/bad/key') return '__INVALID_KEY__';
      if (path === '/exists/file.txt') return Buffer.from('file contents');
      if (path === '/known_hosts') return `192.168.1.100 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDtesthostkeyblob\n`;
      if (path === '/known_hosts_ipv6') return `[::1] ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDtesthostkeyblob\n`;
      if (path.startsWith('/tmp/scp_temp_')) return Buffer.from('temp content');
      throw new Error(`ENOENT: ${path}`);
    }),
    writeFile: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  };
});

import { EventEmitter } from 'node:events';

import { getLogger } from '../../logger/logger.service.js';
import {
  assertSafeScpPath,
  CommandExecutionError,
  createExecutor,
  Executor,
  ExecutorError,
  SCPTransferError,
  SSHConnectionError,
} from '../executor.js';
import type { SSHConfig } from '../ssh.config.js';

const TEST_SSH_CONFIG: SSHConfig = {
  defaultUsername: 'ubuntu',
  defaultPort: 22,
  defaultTimeout: 30,
  defaultKeyPath: '/home/user/.ssh/id_rsa',
  sshConfigPath: '',
  strictHostKeyChecking: false,
  knownHostsPath: '',
  commandTimeout: 300,
  scpTimeout: 120,
};

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  write = vi.fn();
  end = vi.fn();
}

function stubExec(responses: { stdout?: string; stderr?: string; exitCode?: number }[]): string[] {
  const commands: string[] = [];
  let call = 0;
  harness.execImpl = (cmd, cb) => {
    commands.push(cmd);
    const response = responses[Math.min(call, responses.length - 1)] ?? {};
    call += 1;
    const channel = new FakeChannel();
    cb(undefined, channel);
    queueMicrotask(() => {
      if (response.stdout) channel.emit('data', Buffer.from(response.stdout));
      if (response.stderr) channel.stderr.emit('data', Buffer.from(response.stderr));
      channel.emit('close', response.exitCode ?? 0);
    });
  };
  return commands;
}

function makeExecutor(overrides: Record<string, unknown> = {}): Executor {
  harness.connectError = null;
  harness.connectErrors = [];
  harness.connectAttempts = 0;
  return new Executor('192.168.1.100', 'test-job', TEST_SSH_CONFIG, { password: 'secret', ...overrides });
}

async function drainFakeTimersUntilSettled(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise
    .catch(() => undefined)
    .finally(() => {
      settled = true;
    });
  while (!settled) {
    await vi.runAllTimersAsync();
  }
}

beforeEach(() => {
  harness.execImpl = null;
  harness.lastConnectConfig = null;
  harness.connectError = null;
  harness.connectErrors = [];
  harness.connectAttempts = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExecutorError hierarchy', () => {
  it('ExecutorError is a subclass of Error', () => {
    const error = new ExecutorError('Test error');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Test error');
  });

  it('SSHConnectionError extends ExecutorError and Error', () => {
    const error = new SSHConnectionError('Connection failed');
    expect(error).toBeInstanceOf(ExecutorError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Connection failed');
  });

  it('SCPTransferError extends ExecutorError and Error', () => {
    const error = new SCPTransferError('Transfer failed');
    expect(error).toBeInstanceOf(ExecutorError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Transfer failed');
  });

  it('CommandExecutionError extends ExecutorError and Error', () => {
    const error = new CommandExecutionError('Command failed');
    expect(error).toBeInstanceOf(ExecutorError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Command failed');
  });
});

describe('Executor initialization', () => {
  it('initializes with defaults from sshConfig', () => {
    const executor = new Executor('192.168.1.100', 'test-job', TEST_SSH_CONFIG);
    expect(executor.targetIp).toBe('192.168.1.100');
    expect(executor.jobId).toBe('test-job');
    expect(executor.sshConfig).toBe(TEST_SSH_CONFIG);
    expect(executor.effectiveConfig.username).toBe('ubuntu');
    expect(executor.effectiveConfig.port).toBe(22);
  });

  it('applies overrides to effective config', () => {
    const executor = new Executor('192.168.1.100', 'test-job', TEST_SSH_CONFIG, {
      username: 'admin',
      password: 'secret',
      port: 2222,
      timeout: 60,
    });
    expect(executor.effectiveConfig.username).toBe('admin');
    expect(executor.effectiveConfig.password).toBe('secret');
    expect(executor.effectiveConfig.port).toBe(2222);
    expect(executor.effectiveConfig.connectionTimeout).toBe(60);
  });

  it('preserves defaults for non-overridden values', () => {
    const executor = new Executor('192.168.1.100', 'test-job', TEST_SSH_CONFIG, {
      username: 'admin',
      password: 'secret',
      timeout: 60,
    });
    expect(executor.effectiveConfig.port).toBe(22);
  });

  it('treats undefined overrides as no-op', () => {
    const executor = new Executor('192.168.1.100', 'test-job', TEST_SSH_CONFIG, {
      username: undefined,
      password: 'secret',
      timeout: undefined,
    });
    expect(executor.effectiveConfig.username).toBe('ubuntu');
    expect(executor.effectiveConfig.password).toBe('secret');
    expect(executor.effectiveConfig.connectionTimeout).toBe(30);
  });
});

describe('Executor.buildCommand', () => {
  const executor = makeExecutor();

  it('passes plain commands through', () => {
    expect(executor.buildCommand('ls -la')).toBe('ls -la');
  });

  it('prefixes env vars with quoted values', () => {
    const cmd = executor.buildCommand('ls -la', undefined, { PATH: '/usr/bin', DEBUG: '1' });
    expect(cmd).toContain("PATH='/usr/bin'");
    expect(cmd).toContain("DEBUG='1'");
    expect(cmd).toContain('ls -la');
  });

  it('wraps with chroot only', () => {
    expect(executor.buildCommand('ls -la', '/mnt/chroot')).toBe("chroot '/mnt/chroot' /usr/bin/bash -c 'ls -la'");
  });

  it('wraps with chdir only', () => {
    expect(executor.buildCommand('ls -la', undefined, undefined, '/var/log')).toBe(
      "/usr/bin/bash -c 'cd '\\''/var/log'\\'' && ls -la'",
    );
  });

  it('combines env, chroot, and chdir in correct order', () => {
    const cmd = executor.buildCommand('ls -la', '/mnt/chroot', { DEBUG: '1' }, '/var/log');
    expect(cmd).toContain('/var/log');
    expect(cmd).toContain('/mnt/chroot');
    expect(cmd).toContain('ls -la');
    expect(cmd).toMatch(/^\/usr\/bin\/bash -c /);
    expect(cmd).toContain('chroot');
  });

  it('rejects invalid env var names', () => {
    expect(() => executor.buildCommand('ls', undefined, { VALID_NAME: '1' })).not.toThrow();
    expect(() => executor.buildCommand('ls', undefined, { "'; rm -rf /": '1' })).toThrow(
      /Invalid environment variable name/,
    );
    expect(() => executor.buildCommand('ls', undefined, { 'A B': '1' })).toThrow(/Invalid environment variable name/);
  });

  it('escapes shell metacharacters in env var values', () => {
    const cmd = executor.buildCommand('echo test', undefined, { VAR: "val'ue; rm -rf /" });
    expect(cmd).toBe("VAR='val'\\''ue; rm -rf /' echo test");
  });

  it('escapes shell metacharacters in chroot path', () => {
    const cmd = executor.buildCommand('ls', "'; rm -rf /; echo '");
    expect(cmd).toContain("chroot '");
    expect(cmd).not.toBe("chroot '; rm -rf /; echo ' /usr/bin/bash -c 'ls'");
  });

  it('escapes shell metacharacters in chdir path', () => {
    const cmd = executor.buildCommand('ls', undefined, undefined, "'; rm -rf /");
    expect(cmd).not.toContain("cd '; rm -rf / &&");
    expect(cmd).toMatch(/^\/usr\/bin\/bash -c /);
  });
});

describe('Executor.connect', () => {
  it('uses password auth when no key file exists', async () => {
    const executor = makeExecutor();
    await executor.connect();

    expect(harness.lastConnectConfig).toMatchObject({
      host: '192.168.1.100',
      port: 22,
      username: 'ubuntu',
      password: 'secret',
      readyTimeout: 30_000,
    });
    expect(harness.lastConnectConfig?.privateKey).toBeUndefined();
  });

  it('uses key auth when key file exists', async () => {
    const executor = makeExecutor({ keyPath: '/exists/key' });
    await executor.connect();

    expect(harness.lastConnectConfig).toMatchObject({
      host: '192.168.1.100',
      port: 22,
      username: 'ubuntu',
      privateKey: 'PRIVATE_KEY_CONTENT',
      readyTimeout: 30_000,
    });
    expect(harness.lastConnectConfig?.passphrase).toBe('secret');
    expect(harness.lastConnectConfig?.password).toBeUndefined();
  });

  it('falls back to password auth when key file does not exist', async () => {
    const executor = makeExecutor({ keyPath: '/missing/key', password: 'secret' });
    await executor.connect();

    expect(harness.lastConnectConfig).toMatchObject({
      password: 'secret',
    });
    expect(harness.lastConnectConfig?.privateKey).toBeUndefined();
  });

  it('does not reconnect when already connected', async () => {
    const executor = makeExecutor();
    await executor.connect();
    harness.lastConnectConfig = null;

    await executor.connect();
    expect(harness.lastConnectConfig).toBeNull();
  });

  it('throws SSHConnectionError on key import failure', async () => {
    const executor = makeExecutor({ keyPath: '/bad/key' });
    await expect(executor.connect()).rejects.toThrow(SSHConnectionError);
    await expect(makeExecutor({ keyPath: '/bad/key' }).connect()).rejects.toThrow(/SSH key import failed/);
  });

  it('throws SSHConnectionError on SSH error event', async () => {
    const executor = makeExecutor();
    harness.connectError = new Error('Connection refused');

    await expect(executor.connect()).rejects.toThrow(SSHConnectionError);
    const executor2 = makeExecutor();
    harness.connectError = new Error('Connection refused');
    await expect(executor2.connect()).rejects.toThrow(/SSH connection failed: Connection refused/);
  });
});

describe('Executor.connect host-key verification', () => {
  it('installs no hostVerifier when strict checking is off', async () => {
    const executor = makeExecutor();
    await executor.connect();
    expect(harness.lastConnectConfig?.hostVerifier).toBeUndefined();
  });

  it('installs a hostVerifier that accepts a pinned known_hosts key when strict', async () => {
    const executor = makeExecutor({ strictHostKeyChecking: true, knownHostsPath: '/known_hosts' });
    await executor.connect();

    const verifier = harness.lastConnectConfig?.hostVerifier as ((key: Buffer) => boolean) | undefined;
    expect(typeof verifier).toBe('function');
    expect(verifier!(Buffer.from(KNOWN_HOST_KEY_B64, 'base64'))).toBe(true);
  });

  it('hostVerifier rejects a mismatched host key', async () => {
    const executor = makeExecutor({ strictHostKeyChecking: true, knownHostsPath: '/known_hosts' });
    await executor.connect();

    const verifier = harness.lastConnectConfig?.hostVerifier as (key: Buffer) => boolean;
    expect(verifier(Buffer.from('an-attacker-key'))).toBe(false);
  });

  it('hostVerifier fails closed when no known_hosts entry is available', async () => {
    const executor = makeExecutor({ strictHostKeyChecking: true, knownHostsPath: '/missing/known_hosts' });
    await executor.connect();

    const verifier = harness.lastConnectConfig?.hostVerifier as (key: Buffer) => boolean;
    expect(verifier(Buffer.from(KNOWN_HOST_KEY_B64, 'base64'))).toBe(false);
  });

  it('warns when strict checking yields an empty trusted set', async () => {
    const warnSpy = vi.spyOn(getLogger(), 'warning').mockResolvedValue(undefined);
    try {
      const executor = makeExecutor({ strictHostKeyChecking: true, knownHostsPath: '/missing/known_hosts' });
      await executor.connect();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no trusted key'),
        expect.objectContaining({ appClassName: 'adapters-ssh' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('matches an OpenSSH bracket-only IPv6 entry for the default port', async () => {
    harness.connectError = null;
    harness.connectErrors = [];
    harness.connectAttempts = 0;
    const executor = new Executor('::1', 'test-job', TEST_SSH_CONFIG, {
      password: 'secret',
      strictHostKeyChecking: true,
      knownHostsPath: '/known_hosts_ipv6',
    });
    await executor.connect();

    const verifier = harness.lastConnectConfig?.hostVerifier as ((key: Buffer) => boolean) | undefined;
    expect(typeof verifier).toBe('function');
    expect(verifier!(Buffer.from(KNOWN_HOST_KEY_B64, 'base64'))).toBe(true);
  });
});

describe('Executor.disconnect', () => {
  it('closes the connection and clears conn', async () => {
    const executor = makeExecutor();
    await executor.connect();

    await executor.disconnect();
    harness.lastConnectConfig = null;
    await executor.connect();
    expect(harness.lastConnectConfig).not.toBeNull();
  });

  it('is a no-op when there is no active connection', async () => {
    const executor = makeExecutor();
    await expect(executor.disconnect()).resolves.toBeUndefined();
  });
});

describe('Executor.ssh result mapping', () => {
  it('returns trimmed stdout as a single string by default', async () => {
    const executor = makeExecutor();
    stubExec([{ stdout: '  command output \n' }]);

    const result = await executor.ssh('echo hello');
    expect(result).toBe('command output');
  });

  it('returns lines when join is false', async () => {
    const executor = makeExecutor();
    stubExec([{ stdout: 'line1\nline2\nline3\n' }]);

    const result = await executor.ssh('ls', { join: false });
    expect(result).toEqual(['line1', 'line2', 'line3']);
  });

  it('returns empty array for empty output with join=false', async () => {
    const executor = makeExecutor();
    stubExec([{ stdout: '' }]);

    const result = await executor.ssh('true', { join: false });
    expect(result).toEqual([]);
  });

  it('accepts non-zero exit codes listed in allowExitStatuses', async () => {
    const executor = makeExecutor();
    stubExec([{ stdout: 'output', exitCode: 1 }]);

    const result = await executor.ssh('ls -la', { allowExitStatuses: [0, 1] });
    expect(result).toBe('output');
  });

  it('does not raise on non-zero exit when check is false', async () => {
    const executor = makeExecutor();
    stubExec([{ stdout: 'output', exitCode: 1 }]);

    const result = await executor.ssh('ls -la', { check: false });
    expect(result).toBe('output');
  });

  it('auto-connects when conn is null', async () => {
    const executor = makeExecutor();
    stubExec([{ stdout: 'output' }]);
    expect(harness.lastConnectConfig).toBeNull();

    const result = await executor.ssh('ls -la');
    expect(result).toBe('output');
    expect(harness.lastConnectConfig).not.toBeNull();
  });

  it('raises CommandExecutionError after exhausting retries on failing exit codes', async () => {
    vi.useFakeTimers();
    try {
      const executor = makeExecutor();
      const commands = stubExec([{ stdout: '', exitCode: 1 }]);

      const promise = executor.ssh('failing-command');
      const assertion = expect(promise).rejects.toThrow(
        "Unexpected SSH error: Command 'failing-command' failed with exit status 1",
      );
      await drainFakeTimersUntilSettled(promise);
      await assertion;

      expect(commands).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises CommandExecutionError on timeout', async () => {
    vi.useFakeTimers();
    try {
      const executor = makeExecutor();
      await executor.connect();
      harness.execImpl = (_cmd, cb) => {
        const channel = new FakeChannel();
        cb(undefined, channel);
      };

      const promise = executor.ssh('sleep 10', { timeout: 5 });
      const assertion = expect(promise).rejects.toThrow(/timed out after 5 seconds/);
      await drainFakeTimersUntilSettled(promise);
      await assertion;
      await expect(promise).rejects.toBeInstanceOf(CommandExecutionError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps exec callback errors as CommandExecutionError', async () => {
    vi.useFakeTimers();
    try {
      const executor = makeExecutor();
      await executor.connect();
      harness.execImpl = (_cmd, cb) => {
        cb(new Error('SSH error'), undefined as never);
      };

      const promise = executor.ssh('ls -la');
      const assertion = expect(promise).rejects.toThrow(/SSH execution failed: SSH error/);
      await drainFakeTimersUntilSettled(promise);
      await assertion;
      await expect(promise).rejects.toBeInstanceOf(CommandExecutionError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Executor.scp', () => {
  it('uploads from a source path', async () => {
    const executor = makeExecutor();
    await executor.connect();

    harness.execImpl = (cmd, cb) => {
      expect(cmd.startsWith('scp -t')).toBe(true);
      const channel = new FakeChannel();
      cb(undefined, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from([0]));
        queueMicrotask(() => {
          channel.emit('data', Buffer.from([0]));
          queueMicrotask(() => {
            channel.emit('data', Buffer.from([0]));
            queueMicrotask(() => channel.emit('close'));
          });
        });
      });
    };

    await executor.scp({
      sourcePath: '/exists/file.txt',
      destPath: '/remote/file.txt',
      toRemote: true,
    });
  });

  it('uploads from in-memory file contents', async () => {
    const executor = makeExecutor();
    await executor.connect();

    harness.execImpl = (cmd, cb) => {
      expect(cmd.startsWith('scp -t')).toBe(true);
      const channel = new FakeChannel();
      cb(undefined, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from([0]));
        queueMicrotask(() => {
          channel.emit('data', Buffer.from([0]));
          queueMicrotask(() => {
            channel.emit('data', Buffer.from([0]));
            queueMicrotask(() => channel.emit('close'));
          });
        });
      });
    };

    await executor.scp({
      destPath: '/remote/file.txt',
      fileContents: 'test content',
      toRemote: true,
    });

    const fs = await import('node:fs/promises');
    expect(fs.writeFile).toHaveBeenCalled();
  });

  it('downloads from remote', async () => {
    const executor = makeExecutor();
    await executor.connect();

    harness.execImpl = (cmd, cb) => {
      expect(cmd.startsWith('scp -f')).toBe(true);
      const channel = new FakeChannel();
      cb(undefined, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from('C0644 4 file.txt\n'));
        queueMicrotask(() => {
          channel.emit('data', Buffer.from('abcd'));
          queueMicrotask(() => {
            channel.emit('data', Buffer.from([0]));
            queueMicrotask(() => channel.emit('close'));
          });
        });
      });
    };

    await executor.scp({
      sourcePath: '/remote/file.txt',
      destPath: '/local/file.txt',
      toRemote: false,
    });
  });

  it('auto-connects when conn is null', async () => {
    const executor = makeExecutor();
    expect(harness.lastConnectConfig).toBeNull();

    harness.execImpl = (_cmd, cb) => {
      const channel = new FakeChannel();
      cb(undefined, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from([0]));
        queueMicrotask(() => {
          channel.emit('data', Buffer.from([0]));
          queueMicrotask(() => {
            channel.emit('data', Buffer.from([0]));
            queueMicrotask(() => channel.emit('close'));
          });
        });
      });
    };

    await executor.scp({ sourcePath: '/exists/file.txt', destPath: '/remote/file.txt' });
    expect(harness.lastConnectConfig).not.toBeNull();
  });

  it('raises SCPTransferError on timeout', async () => {
    vi.useFakeTimers();
    try {
      const executor = makeExecutor();
      await executor.connect();
      harness.execImpl = (_cmd, cb) => {
        const channel = new FakeChannel();
        cb(undefined, channel);
      };

      const promise = executor.scp({
        sourcePath: '/exists/file.txt',
        destPath: '/remote/file.txt',
        timeout: 30,
      });
      const assertion = expect(promise).rejects.toThrow(/timed out after 30 seconds/);
      await drainFakeTimersUntilSettled(promise);
      await assertion;
      await expect(promise).rejects.toBeInstanceOf(SCPTransferError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps exec callback errors as SCPTransferError', async () => {
    const executor = makeExecutor();
    await executor.connect();
    harness.execImpl = (_cmd, cb) => {
      cb(new Error('Transfer failed'), undefined as never);
    };

    await expect(executor.scp({ sourcePath: '/exists/file.txt', destPath: '/remote/file.txt' })).rejects.toThrow(
      /SCP transfer failed: Transfer failed/,
    );
  });

  it('wraps SSHConnectionError from auto-connect as SCPTransferError "Unexpected"', async () => {
    const executor = makeExecutor();
    harness.connectError = new Error('Connection refused');

    await expect(executor.scp({ sourcePath: '/exists/file.txt', destPath: '/remote/file.txt' })).rejects.toThrow(
      /Unexpected SCP error/,
    );
  });

  it('does not raise when temp file cleanup fails', async () => {
    const executor = makeExecutor();
    await executor.connect();

    const fs = await import('node:fs/promises');
    const unlinkSpy = vi.mocked(fs.unlink);
    unlinkSpy.mockImplementationOnce(async () => {
      throw new Error('Cleanup failed');
    });

    harness.execImpl = (_cmd, cb) => {
      const channel = new FakeChannel();
      cb(undefined, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from([0]));
        queueMicrotask(() => {
          channel.emit('data', Buffer.from([0]));
          queueMicrotask(() => {
            channel.emit('data', Buffer.from([0]));
            queueMicrotask(() => channel.emit('close'));
          });
        });
      });
    };

    await executor.scp({ destPath: '/remote/file.txt', fileContents: 'test content' });
  });
});

describe('Executor.scp remote-path safety', () => {
  it('rejects an upload destPath containing shell metacharacters before any exec', async () => {
    const executor = makeExecutor();
    await executor.connect();

    let execCalled = false;
    harness.execImpl = (_cmd, cb) => {
      execCalled = true;
      cb(undefined, new FakeChannel());
    };

    await expect(
      executor.scp({ sourcePath: '/exists/file.txt', destPath: '/tmp/x; reboot', toRemote: true }),
    ).rejects.toBeInstanceOf(SCPTransferError);
    await expect(
      executor.scp({ sourcePath: '/exists/file.txt', destPath: '/tmp/$(reboot)', toRemote: true }),
    ).rejects.toThrow(/Invalid destPath/);
    expect(execCalled).toBe(false);
  });

  it('rejects a download sourcePath containing shell metacharacters', async () => {
    const executor = makeExecutor();
    await executor.connect();

    let execCalled = false;
    harness.execImpl = (_cmd, cb) => {
      execCalled = true;
      cb(undefined, new FakeChannel());
    };

    await expect(
      executor.scp({ sourcePath: '/remote/`id`.txt', destPath: '/local/file.txt', toRemote: false }),
    ).rejects.toThrow(/Invalid sourcePath/);
    expect(execCalled).toBe(false);
  });

  it('allows a destPath with spaces and shell-quotes it on the wire', async () => {
    const executor = makeExecutor();
    await executor.connect();

    let observedCmd = '';
    harness.execImpl = (cmd, cb) => {
      observedCmd = cmd;
      const channel = new FakeChannel();
      cb(undefined, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from([0]));
        queueMicrotask(() => {
          channel.emit('data', Buffer.from([0]));
          queueMicrotask(() => {
            channel.emit('data', Buffer.from([0]));
            queueMicrotask(() => channel.emit('close'));
          });
        });
      });
    };

    await executor.scp({ sourcePath: '/exists/file.txt', destPath: '/remote/my file.txt', toRemote: true });
    expect(observedCmd).toBe("scp -t '/remote/my file.txt'");
  });

  it('shell-quotes the remote path on download too', async () => {
    const executor = makeExecutor();
    await executor.connect();

    let observedCmd = '';
    harness.execImpl = (cmd, cb) => {
      observedCmd = cmd;
      const channel = new FakeChannel();
      cb(undefined, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from('C0644 4 file.txt\n'));
        queueMicrotask(() => {
          channel.emit('data', Buffer.from('abcd'));
          queueMicrotask(() => {
            channel.emit('data', Buffer.from([0]));
            queueMicrotask(() => channel.emit('close'));
          });
        });
      });
    };

    await executor.scp({ sourcePath: '/remote/my file.txt', destPath: '/local/file.txt', toRemote: false });
    expect(observedCmd).toBe("scp -f '/remote/my file.txt'");
  });
});

describe('assertSafeScpPath', () => {
  it('accepts plain paths and paths with spaces', () => {
    expect(() => assertSafeScpPath('/tmp/normal-path_1.txt', 'destPath')).not.toThrow();
    expect(() => assertSafeScpPath('/remote/my file.txt', 'destPath')).not.toThrow();
    expect(() => assertSafeScpPath('', 'destPath')).not.toThrow();
  });

  it('rejects paths with shell metacharacters', () => {
    for (const bad of ['/tmp/x; reboot', '/tmp/$(reboot)', '/tmp/`id`', '/tmp/a|b', '/tmp/a&b', '/tmp/a>b']) {
      expect(() => assertSafeScpPath(bad, 'destPath')).toThrow(SCPTransferError);
    }
  });
});

describe('createExecutor', () => {
  it('returns an Executor with defaults', async () => {
    const executor = await createExecutor('192.168.1.100', 'test-job');
    expect(executor).toBeInstanceOf(Executor);
    expect(executor.targetIp).toBe('192.168.1.100');
    expect(executor.jobId).toBe('test-job');
  });

  it('passes overrides through to Executor', async () => {
    const executor = await createExecutor('192.168.1.100', 'test-job', {
      username: 'admin',
      password: 'secret',
      timeout: 60,
    });
    expect(executor.effectiveConfig.username).toBe('admin');
    expect(executor.effectiveConfig.password).toBe('secret');
    expect(executor.effectiveConfig.connectionTimeout).toBe(60);
  });
});

describe('Executor integration workflows', () => {
  it('connect failure followed by retry recovers', async () => {
    const executor = makeExecutor();
    harness.connectErrors = [new Error('Connection refused'), null];

    await expect(executor.connect()).rejects.toThrow(SSHConnectionError);
    await expect(executor.connect()).resolves.toBeUndefined();
  });

  it('applies configuration overrides end-to-end', () => {
    const executor = new Executor('192.168.1.100', 'override-test', TEST_SSH_CONFIG, {
      username: 'deploy',
      password: 'secret',
      port: 2222,
      commandTimeout: 600,
    });

    expect(executor.effectiveConfig.username).toBe('deploy');
    expect(executor.effectiveConfig.password).toBe('secret');
    expect(executor.effectiveConfig.port).toBe(2222);
    expect(executor.effectiveConfig.commandTimeout).toBe(600);
    expect(executor.effectiveConfig.connectionTimeout).toBe(30);
  });

  it('complex command runs through buildCommand and timeout option', async () => {
    const executor = makeExecutor();
    const commands = stubExec([{ stdout: 'chroot command output', stderr: 'warning message' }]);

    const output = await executor.ssh('update-grub', {
      chroot: '/mnt/target',
      envVars: { DEBIAN_FRONTEND: 'noninteractive' },
      chdir: '/boot',
      timeout: 600,
    });

    expect(output).toBe('chroot command output');
    expect(commands[0]).toContain('DEBIAN_FRONTEND=');
    expect(commands[0]).toContain('noninteractive');
    expect(commands[0]).toContain('/mnt/target');
    expect(commands[0]).toContain('/boot');
  });
});
