import { getErrorMessage } from '@repo/utils';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Backoff } from '../../connection/backoff';
import { sleepWithAbort } from '../../connection/sleep';
import { dispatchContext } from '../../dispatch/context';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { assertTargetPathSafe } from './target-path';

const logger = makeLogger('deploy');

const RESTORE_TIMEOUT_MS = 45 * 60_000;
const MKDIR_TIMEOUT_MS = 5_000;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 8_000;
// Full jitter alone can roll ~0ms; keep the removed hand-rolled backoff's positive floor (80% of base).
const MIN_BACKOFF_MS = 1_600;

const PROGRESS_PCT_STEP = 0.05;
const PROGRESS_TIME_STEP_MS = 5_000;

const DECOMPRESS_FLAG: Record<'gzip' | 'zstd', string> = {
  gzip: '-z',
  zstd: '--zstd',
};

interface FetchedTempFile {
  path: string;
  bytes: number;
}

class Sha256Mismatch extends Error {
  constructor(
    public expected: string,
    public got: string,
    public url: string,
  ) {
    super(`sha256 mismatch for ${url}: expected=${expected} got=${got}`);
    this.name = 'Sha256Mismatch';
  }
}

function shouldRetry(err: unknown, status: number | null): boolean {
  if (status !== null) return status >= 500 && status < 600;
  if (err instanceof Error && err.name === 'AbortError') return false;
  return true;
}

async function backoffDelay(backoff: Backoff, signal: AbortSignal | undefined): Promise<void> {
  await sleepWithAbort(backoff.next(), signal);
  if (signal?.aborted) throw new Error('aborted during backoff');
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    logger.warn('temp layer file unlink failed', { path, error: getErrorMessage(error) });
  }
}

async function fetchAndVerify(args: {
  url: string;
  sha256: string;
  target_path: string;
  signal: AbortSignal | undefined;
  reportProgress: (pct: number, msg?: string) => void;
  layerNameForLog: string;
}): Promise<FetchedTempFile> {
  const { url, sha256: expected, target_path, signal, reportProgress, layerNameForLog } = args;

  const tmpPath = join(target_path, `.brokkr_layer.${process.pid}.${Date.now()}.tar`);
  let bytesWritten = 0;
  let hash = createHash('sha256');
  let lastProgressBytes = 0;
  let lastProgressTime = Date.now();
  let contentLength: number | null = null;

  const emitProgressIfDue = (forceFlush = false): void => {
    const now = Date.now();
    const pctStepBytes = contentLength ? contentLength * PROGRESS_PCT_STEP : null;
    const pctDue = pctStepBytes !== null && bytesWritten - lastProgressBytes >= pctStepBytes;
    const timeDue = now - lastProgressTime >= PROGRESS_TIME_STEP_MS;
    if (!forceFlush && !pctDue && !timeDue) return;

    lastProgressBytes = bytesWritten;
    lastProgressTime = now;
    const pct = contentLength ? Math.min(1, bytesWritten / contentLength) : 0;
    const sizeMsg = contentLength
      ? `${(bytesWritten / 1_048_576).toFixed(1)}/${(contentLength / 1_048_576).toFixed(1)} MiB`
      : `${(bytesWritten / 1_048_576).toFixed(1)} MiB`;
    reportProgress(pct, `${layerNameForLog} ${sizeMsg}`);
  };

  let lastStatus: number | null = null;
  let lastErr: unknown = null;
  const backoff = new Backoff({
    initial_ms: BASE_BACKOFF_MS,
    max_ms: MAX_BACKOFF_MS,
    min_ms: MIN_BACKOFF_MS,
    factor: 4,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const headers: Record<string, string> = {};
    if (bytesWritten > 0) {
      headers['Range'] = `bytes=${bytesWritten}-`;
    }

    let resp: Response;
    try {
      resp = await fetch(url, { signal: signal ?? null, headers });
    } catch (err) {
      lastErr = err;
      lastStatus = null;
      if (!shouldRetry(err, null) || attempt === MAX_ATTEMPTS) {
        await safeUnlink(tmpPath);
        throw err;
      }
      await backoffDelay(backoff, signal);
      continue;
    }

    if (!resp.ok) {
      lastStatus = resp.status;
      lastErr = new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
      try {
        await resp.body?.cancel();
      } catch (error) {
        logger.warn('layer fetch response body cancel failed', { status: resp.status, error: getErrorMessage(error) });
      }
      if (!shouldRetry(null, resp.status) || attempt === MAX_ATTEMPTS) {
        await safeUnlink(tmpPath);
        throw lastErr;
      }
      await backoffDelay(backoff, signal);
      continue;
    }

    const rangeRequested = !!headers['Range'];
    const rangeHonored = resp.status === 206;
    if (rangeRequested && !rangeHonored) {
      await safeUnlink(tmpPath);
      bytesWritten = 0;
      hash = createHash('sha256');
      lastProgressBytes = 0;
      contentLength = Number(resp.headers.get('content-length')) || null;
    } else if (!rangeRequested) {
      contentLength = Number(resp.headers.get('content-length')) || null;
    } else {
      const cr = resp.headers.get('content-range');
      const m = cr ? cr.match(/\/(\d+)$/) : null;
      if (m) contentLength = Number(m[1]);
    }

    if (!resp.body) {
      lastStatus = resp.status;
      lastErr = new Error(`empty response body for ${url} (status ${resp.status})`);
      if (attempt === MAX_ATTEMPTS) {
        await safeUnlink(tmpPath);
        throw lastErr;
      }
      await backoffDelay(backoff, signal);
      continue;
    }

    const writeStream = createWriteStream(tmpPath, {
      flags: bytesWritten > 0 ? 'a' : 'w',
    });

    let streamError: unknown = null;
    let onStreamError: ((err: unknown) => void) | null = null;
    // 'error' (e.g. ENOSPC) can fire outside the write callback; unhandled it crashes the agent.
    writeStream.on('error', (err) => {
      if (streamError === null) streamError = err;
      onStreamError?.(err);
    });

    const writeChunk = (chunk: Uint8Array): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        writeStream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });

    const reader = resp.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeChunk(value);
        hash.update(value);
        bytesWritten += value.byteLength;
        emitProgressIfDue();
      }
    } catch (err) {
      streamError = err;
    } finally {
      reader.releaseLock();
    }

    if (streamError === null) {
      await new Promise<void>((resolve, reject) => {
        onStreamError = reject;
        writeStream.end(() => resolve());
      }).catch((err) => {
        if (streamError === null) streamError = err;
      });
      onStreamError = null;
    }

    if (streamError !== null) {
      writeStream.destroy();
      lastErr = streamError;
      lastStatus = null;
      const st = await stat(tmpPath).catch(() => null);
      if (st) {
        bytesWritten = st.size;
        const rehash = createHash('sha256');
        await new Promise<void>((resolve, reject) => {
          const s = createReadStream(tmpPath);
          s.on('data', (chunk: string | Buffer) => {
            if (typeof chunk !== 'string') rehash.update(chunk);
          });
          s.on('end', () => resolve());
          s.on('error', reject);
        });
        hash = rehash;
      } else {
        bytesWritten = 0;
        hash = createHash('sha256');
      }
      if (!shouldRetry(streamError, null) || attempt === MAX_ATTEMPTS) {
        await safeUnlink(tmpPath);
        throw streamError;
      }
      await backoffDelay(backoff, signal);
      continue;
    }

    emitProgressIfDue(true);

    const got = hash.digest('hex');
    if (got !== expected) {
      await safeUnlink(tmpPath);
      throw new Sha256Mismatch(expected, got, url);
    }

    return { path: tmpPath, bytes: bytesWritten };
  }

  await safeUnlink(tmpPath);
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`fetch ${url} failed after ${MAX_ATTEMPTS} attempts (status=${lastStatus})`);
}

export function registerHttpsLayerOp(): void {
  registerOperation('deploy.restoreHttpsLayer', async (input, ctx) => {
    const { target_path, url, compression, sha256 } = input;
    assertTargetPathSafe(target_path);

    const signal = ctx.signal ?? dispatchContext.getStore()?.signal;
    const reportProgress = ctx.reportProgress;

    const mkdirResult = await run('mkdir', ['-p', target_path], {
      timeout_ms: MKDIR_TIMEOUT_MS,
      signal,
    });
    if (mkdirResult.exit_code !== 0) {
      throw new Error(`mkdir -p ${target_path} failed (exit=${mkdirResult.exit_code}): ${mkdirResult.stderr.trim()}`);
    }
    await mkdir(target_path, { recursive: true }).catch(() => undefined);

    const layerLog = url.replace(/^.*\/sha256:/, 'sha256:').slice(0, 24);
    const { path: tmpPath, bytes } = await fetchAndVerify({
      url,
      sha256,
      target_path,
      signal,
      reportProgress,
      layerNameForLog: layerLog,
    });

    const decompressFlag = DECOMPRESS_FLAG[compression];
    const tarStdin = createReadStream(tmpPath);
    try {
      const tarResult = await run(
        'tar',
        [
          '-x',
          decompressFlag,
          '-C',
          target_path,
          '--xattrs',
          '--xattrs-include=*',
          '--acls',
          '--numeric-owner',
          '--strip-components=1',
          '--overwrite',
          '--warning=no-timestamp',
        ],
        {
          stdin: tarStdin,
          timeout_ms: RESTORE_TIMEOUT_MS,
          signal,
        },
      );
      if (tarResult.exit_code !== 0) {
        throw new Error(`tar extraction failed (exit=${tarResult.exit_code}): ${tarResult.stderr.trim()}`);
      }
    } finally {
      if (!tarStdin.destroyed) {
        await new Promise<void>((resolve) => {
          tarStdin.once('close', resolve);
          tarStdin.destroy();
        });
      }
      await safeUnlink(tmpPath);
    }

    return { bytes };
  });
}
