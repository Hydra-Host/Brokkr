import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PcProcess } from '../process-compose.client';
import { ProcessComposeClient } from '../process-compose.client';

const { spawnMock, requestMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), requestMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));
vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: requestMock,
}));

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function fakeReq() {
  let onTimeout: (() => void) | undefined;
  const req = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, cb: () => void) => EventEmitter;
    destroy: (err: Error) => EventEmitter;
    end: () => EventEmitter;
    fireTimeout: () => void;
  };
  req.setTimeout = (_ms, cb) => {
    onTimeout = cb;
    return req;
  };
  req.destroy = (err) => {
    req.emit('error', err);
    return req;
  };
  req.end = () => req;
  req.fireTimeout = () => onTimeout?.();
  return req;
}

const jsonSpyTarget = (c: ProcessComposeClient) =>
  c as unknown as { getJson: (path: string, schema: unknown) => Promise<unknown> };

describe('ProcessComposeClient.processInfo — W3 drift-guard read', () => {
  it('GETs /process/info/<name> and returns the Go-field-named config', async () => {
    const client = new ProcessComposeClient();
    const getJson = vi.spyOn(jsonSpyTarget(client), 'getJson').mockResolvedValue({
      Command: 'run-spoke',
      Environment: ['A=1', 'B=2'],
      DependsOn: { redis: { condition: 'process_healthy' } },
    });

    const info = await client.processInfo('spoke');

    expect(getJson).toHaveBeenCalledWith('/process/info/spoke', expect.anything());
    expect(info.Command).toBe('run-spoke');
    expect(info.Environment).toEqual(['A=1', 'B=2']);
    expect(Object.keys(info.DependsOn ?? {})).toEqual(['redis']);
  });

  it('is lenient (passthrough, all optional) — an unexpected/extra shape does not throw', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(jsonSpyTarget(client), 'getJson').mockResolvedValue({ SomeFutureField: 42 });

    await expect(client.processInfo('spoke')).resolves.toBeDefined();
  });

  it('URL-encodes the process name', async () => {
    const client = new ProcessComposeClient();
    const getJson = vi.spyOn(jsonSpyTarget(client), 'getJson').mockResolvedValue({});

    await client.processInfo('zone a/spoke');

    expect(getJson).toHaveBeenCalledWith('/process/info/zone%20a%2Fspoke', expect.anything());
  });
});

describe('ProcessComposeClient.stopAndWait — D1.2 deterministic stop', () => {
  const listSpy = (c: ProcessComposeClient, impl: () => Promise<PcProcess[]>) =>
    vi.spyOn(c, 'listAll').mockImplementation(impl);

  it('returns true once the process is absent from the roster', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(client, 'stop').mockResolvedValue();
    let calls = 0;
    listSpy(client, async () => (calls++ === 0 ? [{ name: 'fleet', status: 'Running' }] : []));

    await expect(client.stopAndWait('fleet', 5_000)).resolves.toBe(true);
  });

  it('returns true once the process reaches a terminal state (Stopped)', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(client, 'stop').mockResolvedValue();
    listSpy(client, async () => [{ name: 'fleet', status: 'Stopped' }]);

    await expect(client.stopAndWait('fleet', 5_000)).resolves.toBe(true);
  });

  it('returns false on timeout when the process never settles', async () => {
    vi.useFakeTimers();
    try {
      const client = new ProcessComposeClient();
      vi.spyOn(client, 'stop').mockResolvedValue();
      listSpy(client, async () => [{ name: 'fleet', status: 'Running' }]);
      const p = client.stopAndWait('fleet', 3_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling through a transient listAll failure (does not throw)', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(client, 'stop').mockResolvedValue();
    let calls = 0;
    listSpy(client, async () => {
      if (calls++ === 0) throw new Error('pc unreachable');
      return [];
    });

    await expect(client.stopAndWait('fleet', 5_000)).resolves.toBe(true);
  });
});

const withStubSocket = () => {
  const prev = process.env.PC_SOCKET_PATH;
  beforeEach(() => {
    process.env.PC_SOCKET_PATH = '/tmp/pc-test.sock';
  });
  afterEach(() => {
    vi.useRealTimers();
    if (prev === undefined) delete process.env.PC_SOCKET_PATH;
    else process.env.PC_SOCKET_PATH = prev;
  });
};

describe('ProcessComposeClient REST socket read timeout', () => {
  withStubSocket();
  beforeEach(() => requestMock.mockReset());

  it('rejects the request when the 5s socket timeout fires on a hung read', async () => {
    const req = fakeReq();
    requestMock.mockReturnValue(req);
    const client = new ProcessComposeClient();

    const p = client.processInfo('spoke');
    req.fireTimeout();

    await expect(p).rejects.toThrow(/timed out after 5s/);
  });
});

describe('ProcessComposeClient.projectUpdate CLI deadline labeling', () => {
  withStubSocket();
  beforeEach(() => spawnMock.mockReset());

  it('labels a SIGKILL that arrives at the deadline as a timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const client = new ProcessComposeClient();

    const p = client.projectUpdate('/cfg/pc.yaml');
    await vi.advanceTimersByTimeAsync(60_000);
    child.emit('close', null, 'SIGKILL');

    await expect(p).rejects.toThrow(/timed out after 60s/);
  });

  it('labels an early external SIGKILL as killed, not a timeout', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const client = new ProcessComposeClient();

    const p = client.projectUpdate('/cfg/pc.yaml');
    child.emit('close', null, 'SIGKILL');

    const message = await p.then(
      () => 'resolved',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(message).toMatch(/killed \(sigkill\)/);
    expect(message).not.toMatch(/timed out/);
  });
});

describe('ProcessComposeClient.followFile', () => {
  const tmpLog = (content: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'pc-follow-')), 'proc.log');
    writeFileSync(path, content);
    return path;
  };

  const follow = (path: string, opts: { backlogBytes?: number; startOffset?: number } = {}) => {
    const got: string[] = [];
    const sub = new ProcessComposeClient().followFile(path, { ...opts, pollMs: 20 }).subscribe((l) => got.push(l));
    return { got, sub };
  };

  it('starts at startOffset and never emits content written before it', async () => {
    const path = tmpLog('before\n');
    const offset = statSync(path).size;
    appendFileSync(path, 'mid\n');
    const { got, sub } = follow(path, { startOffset: offset });
    try {
      appendFileSync(path, 'after\n');
      await vi.waitFor(() => expect(got).toContain('after\n'));
      expect(got).toEqual(['mid\n', 'after\n']);
    } finally {
      sub.unsubscribe();
    }
  });

  it('clamps a startOffset beyond the current size to the end and follows from there', async () => {
    const path = tmpLog('ab\n');
    const { got, sub } = follow(path, { startOffset: 999 });
    try {
      appendFileSync(path, 'cd\n');
      await vi.waitFor(() => expect(got).toEqual(['cd\n']));
    } finally {
      sub.unsubscribe();
    }
  });

  it('emits the whole file when no startOffset is given and the file fits the default backlog', () => {
    const path = tmpLog('a\nb\n');
    const { got, sub } = follow(path);
    try {
      expect(got).toEqual(['a\n', 'b\n']);
    } finally {
      sub.unsubscribe();
    }
  });

  it('starts backlogBytes from the end when the file is larger than the backlog', () => {
    const path = tmpLog('aaaa\nbb\n');
    const { got, sub } = follow(path, { backlogBytes: 3 });
    try {
      expect(got).toEqual(['bb\n']);
    } finally {
      sub.unsubscribe();
    }
  });

  it('resets to offset 0 on truncation and re-emits the rewritten content', async () => {
    const path = tmpLog('first-generation\n');
    const { got, sub } = follow(path);
    try {
      expect(got).toEqual(['first-generation\n']);
      writeFileSync(path, 'rewound\n');
      await vi.waitFor(() => expect(got).toEqual(['first-generation\n', 'rewound\n']));
    } finally {
      sub.unsubscribe();
    }
  });

  it('delivers a delta larger than the read chunk cap in full', async () => {
    const path = tmpLog('');
    const { got, sub } = follow(path);
    try {
      const big = `${'x'.repeat(300 * 1024)}\n`;
      appendFileSync(path, big);
      await vi.waitFor(() => expect(got.join('').length).toBe(big.length));
      expect(got.join('')).toBe(big);
    } finally {
      sub.unsubscribe();
    }
  });

  it('decodes a multi-byte character straddling the chunk seam without corruption', async () => {
    const path = tmpLog('');
    const { got, sub } = follow(path);
    try {
      appendFileSync(path, `${'x'.repeat(256 * 1024 - 1)}é\n`);
      await vi.waitFor(() => expect(got.join('')).toContain('é\n'));
      expect(got.join('')).not.toContain('�');
    } finally {
      sub.unsubscribe();
    }
  });

  it('emits a line split across two ticks once, whole', async () => {
    const path = tmpLog('');
    const { got, sub } = follow(path);
    try {
      appendFileSync(path, 'par');
      await new Promise((r) => setTimeout(r, 70));
      expect(got).toEqual([]);
      appendFileSync(path, 'tial\n');
      await vi.waitFor(() => expect(got).toEqual(['partial\n']));
    } finally {
      sub.unsubscribe();
    }
  });
});

describe('ProcessComposeClient.restartAndWait', () => {
  it('stops first, then starts — pc restart alone leaves a signal-shutdown process down', async () => {
    const client = new ProcessComposeClient();
    const stopAndWait = vi.spyOn(client, 'stopAndWait').mockResolvedValue(true);
    const start = vi.spyOn(client, 'start').mockResolvedValue();
    const restart = vi.spyOn(client, 'restart').mockResolvedValue();

    await expect(client.restartAndWait('spoke')).resolves.toBe(true);

    expect(stopAndWait).toHaveBeenCalledWith('spoke');
    expect(start).toHaveBeenCalledWith('spoke');
    expect(restart).not.toHaveBeenCalled();
    expect(stopAndWait.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
  });

  it('does not start when the stop never settles', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(client, 'stopAndWait').mockResolvedValue(false);
    const start = vi.spyOn(client, 'start').mockResolvedValue();

    await expect(client.restartAndWait('spoke')).resolves.toBe(false);

    expect(start).not.toHaveBeenCalled();
  });

  it('reports false, not a rejection, when the stop settles but the start throws', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(client, 'stopAndWait').mockResolvedValue(true);
    vi.spyOn(client, 'start').mockRejectedValue(new Error('pc 503'));

    await expect(client.restartAndWait('spoke')).resolves.toBe(false);
  });
});

describe('ProcessComposeClient.ensureRunning', () => {
  it('still attempts a start when the stop never settles', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(client, 'stopAndWait').mockResolvedValue(false);
    const start = vi.spyOn(client, 'start').mockResolvedValue();

    await client.ensureRunning('fleet');

    expect(start).toHaveBeenCalledWith('fleet');
  });

  it('swallows a failing start rather than throwing at the caller', async () => {
    const client = new ProcessComposeClient();
    vi.spyOn(client, 'stopAndWait').mockResolvedValue(false);
    vi.spyOn(client, 'start').mockRejectedValue(new Error('pc 404'));

    await expect(client.ensureRunning('fleet')).resolves.toBeUndefined();
  });
});
