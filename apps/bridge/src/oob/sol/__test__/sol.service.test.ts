import { describe, expect, it, vi } from 'vitest';

import { IPMIValidationError } from '../../ipmi/validation.js';
import { SOLService, solLogKey, type SOLServiceDeps } from '../sol.service.js';
import type { IPMIDevice, IPMIResult, SolLogger, SolStream } from '../sol.types.js';

function okResult(): IPMIResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    returncode: 0,
    command: [],
    cipherUsed: null,
    durationMs: 1,
    timedOut: false,
  };
}

function noopLogger(): SolLogger {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function* emptyStream(): SolStream {
}

function makeDeps(overrides: Partial<SOLServiceDeps> = {}): SOLServiceDeps {
  return {
    cache: { rpush: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(true) },
    getCipher: vi.fn().mockResolvedValue('3'),
    solDeactivateFn: vi.fn().mockResolvedValue(okResult()),
    pingFn: vi.fn().mockResolvedValue({ result: 'success', response: 'ok' }),
    streamFactory: vi.fn(() => emptyStream()),
    logger: noopLogger(),
    ...overrides,
  };
}

async function* streamOf(chunks: readonly string[]): SolStream {
  for (const chunk of chunks) {
    yield Buffer.from(chunk, 'utf8');
  }
}

function parseEntry(raw: string): { timestamp: string; message: string } {
  return JSON.parse(raw) as { timestamp: string; message: string };
}

describe('solLogKey', () => {
  it('builds the redis key', () => {
    expect(solLogKey('plan-9')).toBe('sol:logs:plan-9');
  });
});

describe('SOLService.scanStream', () => {
  it('matches the first token in stream order and stops', async () => {
    const service = new SOLService('job-1', makeDeps());
    const result = await service.scanStream({
      tokens: ['##TOK_A##', '##TOK_B##'],
      stream: streamOf(['noise\n', 'xx ##TOK_B## yy ##TOK_A## zz\n']),
      timeout: 5,
    });

    const matches = result['matches'] as { token: string }[];
    expect(matches.map((m) => m.token)).toEqual(['##TOK_B##', '##TOK_A##']);
    expect(result['lines_seen']).toBe(2);
    expect(result['error']).toBeNull();
  });

  it('matches tokens straddling chunk boundaries', async () => {
    const service = new SOLService('job-1', makeDeps());
    const result = await service.scanStream({
      tokens: ['##SPLIT_TOKEN##'],
      stream: streamOf(['prefix ##SPLIT_', 'TOKEN## suffix']),
      timeout: 5,
    });

    const matches = result['matches'] as { token: string }[];
    expect(matches).toHaveLength(1);
  });

  it('returns no matches when the stream ends quietly', async () => {
    const service = new SOLService('job-1', makeDeps());
    const result = await service.scanStream({
      tokens: ['##NOPE##'],
      stream: streamOf(['a\n', 'b\n']),
      timeout: 5,
    });
    expect(result['matches']).toEqual([]);
    expect(result['lines_seen']).toBe(2);
  });

  it('captures stream exceptions in the error field', async () => {
    async function* exploding(): SolStream {
      yield Buffer.from('ok\n', 'utf8');
      throw new Error('stream died');
    }
    const service = new SOLService('job-1', makeDeps());
    const result = await service.scanStream({
      tokens: ['##X##'],
      stream: exploding(),
      timeout: 5,
    });
    expect(String(result['error'])).toContain('stream died');
  });
});

describe('SOLService.probeForTokens', () => {
  it('deactivates before and after scanning', async () => {
    const order: string[] = [];
    const solDeactivateFn = vi.fn(async () => {
      order.push('deactivate');
      return okResult();
    });
    const streamFactory = vi.fn((_device: IPMIDevice): SolStream => {
      order.push('stream');
      return streamOf(['hello ##TOK## world\n']);
    });
    const service = new SOLService('job-1', makeDeps({ solDeactivateFn, streamFactory }));

    const result = await service.probeForTokens({
      ipAddress: '10.0.0.9',
      username: 'admin',
      password: 'secret',
      tokens: ['##TOK##'],
      timeout: 5,
    });

    expect(order).toEqual(['deactivate', 'stream', 'deactivate']);
    const matches = result['matches'] as { token: string }[];
    expect(matches.map((m) => m.token)).toEqual(['##TOK##']);
  });

  it('returns an error envelope carrying the underlying error message when the stream factory throws during setup', async () => {
    const getCipher = vi.fn().mockRejectedValue(new Error('cipher probe failed'));
    const service = new SOLService('job-1', makeDeps({ getCipher }));

    const result = await service.probeForTokens({
      ipAddress: '10.0.0.9',
      username: 'admin',
      password: 'secret',
      tokens: ['##TOK##'],
      timeout: 5,
    });

    expect(result['matches']).toEqual([]);
    expect(result['error']).toBe('cipher probe failed');
  });
});

describe('SOLService.deactivateSession', () => {
  it('reports success even when no session existed', async () => {
    const service = new SOLService('job-1', makeDeps());
    expect(await service.deactivateSession({ ipAddress: '10.0.0.9', username: 'a', password: 'b' })).toEqual({
      deactivated: true,
    });
  });

  it('reports failure on exception', async () => {
    const solDeactivateFn = vi.fn().mockRejectedValue(new Error('bmc gone'));
    const service = new SOLService('job-1', makeDeps({ solDeactivateFn }));
    const result = await service.deactivateSession({
      ipAddress: '10.0.0.9',
      username: 'a',
      password: 'b',
    });
    expect(result['deactivated']).toBe(false);
    expect(String(result['error'])).toContain('bmc gone');
  });
});

describe('SOLService.monitorSession', () => {
  const SESSION_ARGS = {
    planId: 'plan-1',
    ipAddress: '10.0.0.9',
    username: 'admin',
    password: 'secret',
  };

  it('skips the session when the BMC is unreachable', async () => {
    const pingFn = vi.fn().mockResolvedValue({ result: 'failure', response: 'no' });
    const streamFactory = vi.fn();
    const service = new SOLService('job-1', makeDeps({ pingFn, streamFactory }));

    const result = await service.monitorSession(SESSION_ARGS);

    expect(result).toEqual({
      detected: false,
      log_count: 0,
      skipped: true,
      reason: 'BMC unreachable',
    });
    expect(streamFactory).not.toHaveBeenCalled();
  });

  it('detects the pass condition and flushes logs', async () => {
    const rpush = vi.fn().mockResolvedValue(1);
    const expire = vi.fn().mockResolvedValue(true);
    const streamFactory = (): SolStream => streamOf(['boot line one\nboot line two\n', 'ubuntu login: ']);
    const service = new SOLService('job-1', makeDeps({ cache: { rpush, expire }, streamFactory }));

    const result = await service.monitorSession(SESSION_ARGS);

    expect(result['detected']).toBe(true);
    expect(result['log_count']).toBe(3);
    const allEntries = rpush.mock.calls.flatMap((call) => (call[1] as string[]).map((raw) => parseEntry(raw)));
    const messages = allEntries.map((e) => e.message);
    expect(messages[0]).toBe('BEGIN LOG COLLECTION');
    expect(messages).toContain('boot line one');
    expect(messages).toContain('boot line two');
    expect(messages[messages.length - 1]).toBe('END LOG COLLECTION');
    expect(rpush.mock.calls.every((call) => call[0] === 'sol:logs:plan-1')).toBe(true);
  });

  it('detects the fail condition', async () => {
    const streamFactory = (): SolStream => streamOf(['grub> ']);
    const service = new SOLService('job-1', makeDeps({ streamFactory }));

    const result = await service.monitorSession(SESSION_ARGS);

    expect(result['detected']).toBe(false);
  });

  it('filters the SOL banner line from logs', async () => {
    const rpush = vi.fn().mockResolvedValue(1);
    const streamFactory = (): SolStream =>
      streamOf(['[SOL Session operational.  Use ~? for help]\nreal line\n login: ']);
    const service = new SOLService(
      'job-1',
      makeDeps({ cache: { rpush, expire: vi.fn().mockResolvedValue(true) }, streamFactory }),
    );

    const result = await service.monitorSession(SESSION_ARGS);

    expect(result['log_count']).toBe(2);
    const allEntries = rpush.mock.calls.flatMap((call) => (call[1] as string[]).map((raw) => parseEntry(raw)));
    expect(allEntries.some((e) => e.message.includes('SOL Session operational'))).toBe(false);
  });

  it('times out when only idle chunks arrive', async () => {
    async function* idleStream(): SolStream {
      yield Buffer.from('partial', 'utf8');
      for (;;) {
        yield Buffer.alloc(0);
      }
    }
    const service = new SOLService('job-1', makeDeps({ streamFactory: () => idleStream() }));

    const result = await service.monitorSession({ ...SESSION_ARGS, timeout: 0 });

    expect(result['detected']).toBe(false);
    expect(result['log_count']).toBe(1);
  });
});

describe('SOLService input validation', () => {
  const SESSION_ARGS = {
    planId: 'plan-1',
    ipAddress: '10.0.0.9',
    username: 'admin',
    password: 'secret',
  };

  it('rejects a malicious bmc_ip before building the ipmitool argv in monitorSession', async () => {
    const streamFactory = vi.fn();
    const service = new SOLService('job-1', makeDeps({ streamFactory }));

    await expect(service.monitorSession({ ...SESSION_ARGS, ipAddress: '10.0.0.9; rm -rf /' })).rejects.toThrow(
      IPMIValidationError,
    );
    expect(streamFactory).not.toHaveBeenCalled();
  });

  it('rejects a bmc_ip carrying an ipmitool flag in monitorSession', async () => {
    const streamFactory = vi.fn();
    const service = new SOLService('job-1', makeDeps({ streamFactory }));

    await expect(service.monitorSession({ ...SESSION_ARGS, ipAddress: '-oProxyCommand=evil' })).rejects.toThrow(
      IPMIValidationError,
    );
    expect(streamFactory).not.toHaveBeenCalled();
  });

  it('rejects a username with shell metacharacters in monitorSession', async () => {
    const streamFactory = vi.fn();
    const service = new SOLService('job-1', makeDeps({ streamFactory }));

    await expect(service.monitorSession({ ...SESSION_ARGS, username: 'admin;reboot' })).rejects.toThrow(
      IPMIValidationError,
    );
    expect(streamFactory).not.toHaveBeenCalled();
  });

  it('rejects a malicious bmc_ip in deactivateSession without invoking ipmitool', async () => {
    const solDeactivateFn = vi.fn();
    const service = new SOLService('job-1', makeDeps({ solDeactivateFn }));

    const result = await service.deactivateSession({
      ipAddress: '10.0.0.9; rm -rf /',
      username: 'admin',
      password: 'b',
    });

    expect(result['deactivated']).toBe(false);
    expect(String(result['error'])).toContain('Invalid IP');
    expect(solDeactivateFn).not.toHaveBeenCalled();
  });
});
