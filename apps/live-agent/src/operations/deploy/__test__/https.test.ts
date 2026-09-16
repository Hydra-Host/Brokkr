import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

const fsp = vi.hoisted(() => {
  const rmCalls: string[] = [];
  return { rmCalls };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rm: typeof actual.rm = (path, options) => {
    fsp.rmCalls.push(path.toString());
    return actual.rm(path, options);
  };
  return { ...actual, rm };
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
let extraction: { args: readonly string[]; excludeContent: string | null } | null;

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

function extractionArgs(): readonly string[] | undefined {
  return runMock.mock.calls.find((c) => c[0] === 'tar' && c[1]?.includes('-x') === true)?.[1];
}

interface ArchiveEntry {
  name: string;
  mode: string;
  size: string;
}

const dirEntry = (name: string): ArchiveEntry => ({ name, mode: 'drwxr-xr-x', size: '0' });
const fileEntry = (name: string): ArchiveEntry => ({ name, mode: '-rw-r--r--', size: '42' });
const whiteoutEntry = (name: string): ArchiveEntry => ({ name, mode: 'crw-r--r--', size: '0,0' });

function mockArchive(entries: ArchiveEntry[], extractResult: typeof OK = OK): void {
  runMock.mockImplementation(async (cmd, args = []) => {
    if (cmd !== 'tar') return OK;
    if (args[0] === '-t') return { ...OK, stdout: entries.map((e) => `${e.name}\n`).join('') };
    if (args[0] === '-tv') {
      return { ...OK, stdout: entries.map((e) => `${e.mode} 0/0 ${e.size} 2025-01-01 00:00 ${e.name}\n`).join('') };
    }
    const excludeFrom = args.find((a) => a.startsWith('--exclude-from='));
    extraction = {
      args,
      excludeContent:
        excludeFrom === undefined ? null : await readFile(excludeFrom.slice('--exclude-from='.length), 'utf8'),
    };
    return extractResult;
  });
}

beforeEach(async () => {
  runMock.mockReset();
  clearOperationsForTests();
  registerHttpsLayerOp();
  target = await mkdtemp(join(tmpdir(), 'brokkr-https-test-'));
  progress = [];
  ctx = makeCtx(new AbortController().signal);
  fsp.rmCalls.length = 0;
  extraction = null;
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

    const tarArgs = extractionArgs();
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
    const tarArgs = extractionArgs();
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
    runMock.mockImplementation((cmd, args = []) =>
      Promise.resolve(cmd === 'tar' && args.includes('-x') ? FAIL('bad tar') : OK),
    );

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

describe('deploy.restoreHttpsLayer — whiteouts', () => {
  const body = 'layer with whiteouts';
  const input = (): object => ({
    target_path: target,
    url: 'https://cache.example.com/sha256:abc',
    compression: 'zstd',
    sha256: sha256OfBytes(body),
  });

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(body));
  });

  it('removes the mapped file and directory tree, then extracts with those members excluded', async () => {
    await mkdir(join(target, 'usr/lib/linux-tools-6.8.0-136/bin'), { recursive: true });
    await writeFile(join(target, 'usr/lib/linux-tools-6.8.0-136/bin/perf'), 'x');
    await mkdir(join(target, 'boot'));
    await writeFile(join(target, 'boot/vmlinuz-6.8.0-136-generic'), 'x');
    await writeFile(join(target, 'boot/keep'), 'x');
    mockArchive([
      dirEntry('./'),
      dirEntry('./usr/'),
      fileEntry('./usr/lib/keep.txt'),
      whiteoutEntry('./usr/lib/linux-tools-6.8.0-136'),
      dirEntry('./boot/'),
      whiteoutEntry('./boot/vmlinuz-6.8.0-136-generic'),
    ]);

    await dispatch(input());

    expect(fsp.rmCalls).toEqual([
      join(target, 'usr/lib/linux-tools-6.8.0-136'),
      join(target, 'boot/vmlinuz-6.8.0-136-generic'),
    ]);
    expect(existsSync(join(target, 'usr/lib/linux-tools-6.8.0-136'))).toBe(false);
    expect(existsSync(join(target, 'boot/vmlinuz-6.8.0-136-generic'))).toBe(false);
    expect(existsSync(join(target, 'boot/keep'))).toBe(true);
    const args = extraction?.args ?? [];
    expect(args.slice(args.indexOf('--anchored'))).toEqual([
      '--anchored',
      '--no-wildcards',
      expect.stringMatching(/^--exclude-from=.*\.brokkr_layer\..*\.exclude$/),
    ]);
    expect(extraction?.excludeContent).toBe('./usr/lib/linux-tools-6.8.0-136\n./boot/vmlinuz-6.8.0-136-generic\n');
    expect(await tempFiles()).toEqual([]);
  });

  it('lists the archive twice from the temp file with a raised stdout cap', async () => {
    mockArchive([dirEntry('./'), fileEntry('./etc/hosts')]);

    await dispatch(input());

    const listCalls = runMock.mock.calls.filter((c) => c[0] === 'tar' && (c[1]?.[0] === '-t' || c[1]?.[0] === '-tv'));
    expect(listCalls.map((c) => c[1]?.[0])).toEqual(['-t', '-tv']);
    for (const [, args, opts] of listCalls) {
      expect(args).toContain('--zstd');
      const fileIndex = args?.indexOf('-f') ?? -1;
      expect(args?.[fileIndex + 1]).toMatch(/\.brokkr_layer\..*\.tar$/);
      expect(opts?.max_stdout_chars).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    }
  });

  it('removes nothing and extracts with the unchanged arguments when the layer has no whiteouts', async () => {
    mockArchive([dirEntry('./'), fileEntry('./etc/hosts'), { name: './dev/null', mode: 'crw-rw-rw-', size: '1,3' }]);

    await dispatch(input());

    expect(fsp.rmCalls).toEqual([]);
    expect(extraction?.args).toEqual([
      '-x',
      '--zstd',
      '-C',
      target,
      '--xattrs',
      '--xattrs-include=*',
      '--acls',
      '--numeric-owner',
      '--strip-components=1',
      '--overwrite',
      '--warning=no-timestamp',
    ]);
    expect(extraction?.excludeContent).toBeNull();
    expect(await tempFiles()).toEqual([]);
  });

  it.each(['./x/../../etc/passwd', '/etc/shadow', 'usr', '.'])(
    'rejects whiteout member %s before removing or extracting anything',
    async (member) => {
      mockArchive([dirEntry('./'), whiteoutEntry('./usr/lib/gone'), whiteoutEntry(member)]);

      await expect(dispatch(input())).rejects.toThrow(/does not map to a path under/);

      expect(fsp.rmCalls).toEqual([]);
      expect(extraction).toBeNull();
      expect(await tempFiles()).toEqual([]);
    },
  );

  it('maps a member name containing a space', async () => {
    mockArchive([dirEntry('./'), whiteoutEntry('./usr/lib/with space.txt')]);

    await dispatch(input());

    expect(fsp.rmCalls).toEqual([join(target, 'usr/lib/with space.txt')]);
    expect(extraction?.excludeContent).toBe('./usr/lib/with space.txt\n');
  });

  it('drops exactly the first path component whether or not it is a leading dot', async () => {
    mockArchive([whiteoutEntry('rootfs/etc/old.conf'), whiteoutEntry('./var/cache'), whiteoutEntry('.//opt//stale')]);

    await dispatch(input());

    expect(fsp.rmCalls).toEqual([join(target, 'etc/old.conf'), join(target, 'var/cache'), join(target, 'opt/stale')]);
  });

  it('rejects when the name and detail listings disagree in length', async () => {
    runMock.mockImplementation(async (cmd, args = []) => {
      if (cmd === 'tar' && args[0] === '-t') return { ...OK, stdout: './a\n./b\n' };
      if (cmd === 'tar' && args[0] === '-tv') return { ...OK, stdout: 'crw-r--r-- 0/0 0,0 2025-01-01 00:00 ./a\n' };
      return OK;
    });

    await expect(dispatch(input())).rejects.toThrow(/listings disagree/);

    expect(fsp.rmCalls).toEqual([]);
    expect(extraction).toBeNull();
  });

  it('unlinks the exclude file when extraction fails', async () => {
    mockArchive([whiteoutEntry('./var/cache')], FAIL('bad tar'));

    await expect(dispatch(input())).rejects.toThrow(/tar extraction failed.*bad tar/);

    expect(await tempFiles()).toEqual([]);
  });
});
