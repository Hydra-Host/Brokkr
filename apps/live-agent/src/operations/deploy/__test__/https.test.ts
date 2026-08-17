import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

const fsOverrides = vi.hoisted(() => ({ createWriteStream: null as null | ((...args: unknown[]) => unknown) }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (...args: unknown[]) =>
      (fsOverrides.createWriteStream ?? actual.createWriteStream)(
        ...(args as Parameters<typeof actual.createWriteStream>),
      ),
  };
});

import { dispatchContext } from '../../../dispatch/context';
import { clearOperationsForTests, getHandler, type HandlerContext } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerHttpsLayerOp } from '.././https';

const runMock = vi.mocked(run);
const OK = { exit_code: 0, stdout: '', stderr: '', duration_ms: 0 };
const FAIL = (stderr = 'boom'): typeof OK => ({ exit_code: 1, stdout: '', stderr, duration_ms: 0 });

let target: string;
let progress: Array<{ pct: number; msg: string | undefined }>;
let ctx: HandlerContext;

function makeCtx(signal: AbortSignal): HandlerContext {
  return {
    work_id: 'test-work',
    job_id: 'test-job',
    signal,
    resultDelivered: Promise.resolve(),
    reportProgress: (pct: number, msg?: string) => {
      progress.push({ pct, msg });
    },
    emit: async () => {},
  };
}

function sha256OfBytes(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function ok(body: string, init: { contentLength?: number; status?: number; contentRange?: string } = {}): Response {
  const headers = new Headers();
  headers.set('content-length', String(init.contentLength ?? body.length));
  if (init.contentRange) headers.set('content-range', init.contentRange);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    statusText: 'OK',
    headers,
  });
}

function brokenAfter(headBytes: number, fullBody: string): Response {
  const headers = new Headers();
  headers.set('content-length', String(fullBody.length));
  let yielded = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!yielded) {
        controller.enqueue(new TextEncoder().encode(fullBody.slice(0, headBytes)));
        yielded = true;
      } else {
        controller.error(new Error('ECONNRESET mid-stream'));
      }
    },
  });
  return new Response(stream, { status: 200, headers });
}

function err(status: number): Response {
  return new Response(null, { status, statusText: String(status) });
}

async function dispatch(input: object): Promise<unknown> {
  const handler = getHandler('deploy.restoreHttpsLayer');
  if (!handler) throw new Error('handler not registered');
  return dispatchContext.run({ signal: ctx.signal }, () => handler.handler(input, ctx));
}

async function tempFiles(): Promise<string[]> {
  const entries = await readdir(target);
  return entries.filter((e) => e.startsWith('.brokkr_layer.'));
}

beforeEach(async () => {
  runMock.mockReset();
  clearOperationsForTests();
  registerHttpsLayerOp();
  target = await mkdtemp(join(tmpdir(), 'brokkr-https-test-'));
  progress = [];
  ctx = makeCtx(new AbortController().signal);
  runMock.mockResolvedValue(OK);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(target, { recursive: true, force: true });
});

describe('deploy.restoreHttpsLayer — happy path', () => {
  it('fetches, verifies sha256, extracts via tar, returns byte count', async () => {
    const body = 'fake tarball bytes';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(body));

    const result = (await dispatch({
      target_path: target,
      url: 'https://cache.example.com/sha256:deadbeef',
      compression: 'zstd',
      sha256: sha256OfBytes(body),
    })) as { bytes: number };

    expect(result.bytes).toBe(body.length);

    const calls = runMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain('mkdir');
    expect(calls).toContain('tar');

    const tarCall = runMock.mock.calls.find((c) => c[0] === 'tar');
    const tarArgs = tarCall?.[1] as string[];
    expect(tarArgs).toContain('--zstd');
    expect(tarArgs).toContain('--xattrs');
    expect(tarArgs).toContain('--acls');
    expect(tarArgs).toContain('--numeric-owner');
    expect(tarArgs).toContain('--strip-components=1');
    expect(tarArgs).toContain('--overwrite');

    expect(progress.length).toBeGreaterThan(0);

    expect(await tempFiles()).toEqual([]);

    fetchSpy.mockRestore();
  });

  it('uses -z flag for gzip compression', async () => {
    const body = 'gzipped';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(body));
    await dispatch({
      target_path: target,
      url: 'https://cache.example.com/sha256:abc',
      compression: 'gzip',
      sha256: sha256OfBytes(body),
    });
    const tarArgs = runMock.mock.calls.find((c) => c[0] === 'tar')?.[1] as string[];
    expect(tarArgs).toContain('-z');
    expect(tarArgs).not.toContain('--zstd');
  });
});

describe('deploy.restoreHttpsLayer — verification', () => {
  it('throws Sha256Mismatch when body hash differs, unlinks temp file', async () => {
    const body = 'corrupt body';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(body));

    await expect(
      dispatch({
        target_path: target,
        url: 'https://cache.example.com/sha256:abc',
        compression: 'zstd',
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/sha256 mismatch/);

    expect(runMock.mock.calls.filter((c) => c[0] === 'tar')).toHaveLength(0);
    expect(await tempFiles()).toEqual([]);
  });

  it('throws on tar non-zero exit, cleans up temp file', async () => {
    const body = 'valid bytes';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(body));
    runMock.mockImplementation((cmd) => Promise.resolve(cmd === 'tar' ? FAIL('bad tar') : OK));

    await expect(
      dispatch({
        target_path: target,
        url: 'https://cache.example.com/sha256:abc',
        compression: 'zstd',
        sha256: sha256OfBytes(body),
      }),
    ).rejects.toThrow(/tar extraction failed.*bad tar/);

    expect(await tempFiles()).toEqual([]);
  });
});

describe('deploy.restoreHttpsLayer — retry policy', () => {
  it('does NOT retry on 4xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(err(404));

    await expect(
      dispatch({
        target_path: target,
        url: 'https://cache.example.com/sha256:abc',
        compression: 'zstd',
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/HTTP 404/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await tempFiles()).toEqual([]);
  });

  it('retries on 5xx then succeeds, hash spans the successful attempt', async () => {
    const body = 'retry success';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(err(503)).mockResolvedValueOnce(ok(body));

    const result = (await dispatch({
      target_path: target,
      url: 'https://cache.example.com/sha256:abc',
      compression: 'zstd',
      sha256: sha256OfBytes(body),
    })) as { bytes: number };

    expect(result.bytes).toBe(body.length);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('exhausts retries on persistent 5xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(err(503));

    await expect(
      dispatch({
        target_path: target,
        url: 'https://cache.example.com/sha256:abc',
        compression: 'zstd',
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/HTTP 503/);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(await tempFiles()).toEqual([]);
  }, 60_000);
});

describe('deploy.restoreHttpsLayer — Range resume with fallback', () => {
  it('sends Range header on retry after partial body', async () => {
    const body = 'first half second half';
    const headBytes = 'first half'.length;
    const tailBody = body.slice(headBytes);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(brokenAfter(headBytes, body))
      .mockResolvedValueOnce(
        ok(tailBody, {
          contentLength: body.length,
          status: 206,
          contentRange: `bytes ${headBytes}-${body.length - 1}/${body.length}`,
        }),
      );

    const result = (await dispatch({
      target_path: target,
      url: 'https://cache.example.com/sha256:abc',
      compression: 'zstd',
      sha256: sha256OfBytes(body),
    })) as { bytes: number };

    expect(result.bytes).toBe(body.length);
    const secondInit = fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined;
    const headers = (secondInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Range).toBe(`bytes=${headBytes}-`);
  }, 30_000);

  it('falls back to full restart when server returns 200 to Range request', async () => {
    const body = 'full body bytes after fallback';
    const headBytes = 'partial'.length;

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(brokenAfter(headBytes, body))
      .mockResolvedValueOnce(ok(body, { contentLength: body.length, status: 200 }));

    const result = (await dispatch({
      target_path: target,
      url: 'https://cache.example.com/sha256:abc',
      compression: 'zstd',
      sha256: sha256OfBytes(body),
    })) as { bytes: number };

    expect(result.bytes).toBe(body.length);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 30_000);
});

describe('deploy.restoreHttpsLayer — abort', () => {
  it('cleans up temp file when abort signal fires before fetch returns', async () => {
    const ac = new AbortController();
    const localCtx = makeCtx(ac.signal);

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const sig = (init as RequestInit | undefined)?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        sig?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        ac.abort();
      });
    });

    const handler = getHandler('deploy.restoreHttpsLayer');
    await expect(
      dispatchContext.run({ signal: ac.signal }, () =>
        handler!.handler(
          {
            target_path: target,
            url: 'https://cache.example.com/sha256:abc',
            compression: 'zstd',
            sha256: 'a'.repeat(64),
          },
          localCtx,
        ),
      ),
    ).rejects.toThrow();

    expect(await tempFiles()).toEqual([]);
  });
});

describe('deploy.restoreHttpsLayer — progress emission', () => {
  it('emits progress at least once with size context', async () => {
    const body = 'enough bytes to trigger progress'.repeat(100);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(body));

    await dispatch({
      target_path: target,
      url: 'https://cache.example.com/sha256:abc',
      compression: 'zstd',
      sha256: sha256OfBytes(body),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => /MiB/.test(p.msg ?? ''))).toBe(true);
  });
});

describe('deploy.restoreHttpsLayer — write errors', () => {
  it('rejects (does not crash) when the write stream emits ENOSPC out-of-band', async () => {
    const body = 'fake tarball bytes';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(ok(body)));

    fsOverrides.createWriteStream = () => {
      const stream = new Writable({
        write(_chunk, _enc, cb) {
          cb();
          queueMicrotask(() =>
            stream.emit(
              'error',
              Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }),
            ),
          );
        },
      });
      return stream;
    };
    try {
      await expect(
        dispatch({
          target_path: target,
          url: 'https://cache.example.com/sha256:abc',
          compression: 'zstd',
          sha256: sha256OfBytes(body),
        }),
      ).rejects.toThrow(/ENOSPC/);
    } finally {
      fsOverrides.createWriteStream = null;
    }
  }, 30_000);
});

void readFile;
