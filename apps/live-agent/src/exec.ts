import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

import { dispatchContext } from './dispatch/context';
import { makeLogger, type Level } from './logger';
const logger = makeLogger('exec');

const STDERR_LOG_CAP = 512;

const DEFAULT_MAX_STREAM_CHARS = 32 * 1024 * 1024;

export interface RunOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeout_ms?: number | undefined;
  stdin?: string | Buffer | Readable | undefined;
  signal?: AbortSignal | undefined;
  onStderrLine?: ((line: string) => void) | undefined;
  onStdoutLine?: ((line: string) => void) | undefined;
  max_stdout_chars?: number | undefined;
  max_stderr_chars?: number | undefined;
  quiet_nonzero?: boolean | undefined;
  log_class?: string | undefined;
  quiet?: boolean | undefined;
  stdout_level?: Level | undefined;
  stderr_level?: Level | undefined;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

export class CommandTimeout extends Error {
  constructor(
    public cmd: string,
    public timeout_ms: number,
  ) {
    super(`command timed out after ${timeout_ms}ms: ${cmd}`);
  }
}

export class CommandAborted extends Error {
  constructor(public cmd: string) {
    super(`command aborted: ${cmd}`);
  }
}

export class CommandOutputTooLarge extends Error {
  constructor(
    public cmd: string,
    public stream: 'stdout' | 'stderr',
    public cap_chars: number,
  ) {
    super(`command ${stream} exceeded ${cap_chars} UTF-16 code units: ${cmd}`);
  }
}

interface ProcState {
  stdoutChunks: string[];
  stderrChunks: string[];
  timedOut: boolean;
  aborted: boolean;
  overflow: 'stdout' | 'stderr' | null;
  sigkillTimers: NodeJS.Timeout[];
}

function scheduleSigkill(child: ChildProcessWithoutNullStreams, state: ProcState): void {
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 5_000);
  t.unref();
  state.sigkillTimers.push(t);
}

function killForOverflow(child: ChildProcessWithoutNullStreams, state: ProcState, which: 'stdout' | 'stderr'): void {
  if (state.overflow !== null) return;
  state.overflow = which;
  child.kill('SIGTERM');
  scheduleSigkill(child, state);
}

interface StreamSink {
  chunks: string[];
  cap: number;
  emit: ((line: string) => void) | null;
}

function collectStream(
  stream: Readable,
  which: 'stdout' | 'stderr',
  sink: StreamSink,
  state: ProcState,
  onOverflow: (which: 'stdout' | 'stderr') => void,
): void {
  let chars = 0;
  let lineBuf = '';
  stream.on('data', (chunk: Buffer | string) => {
    const s = chunk.toString();
    if (state.overflow === null) {
      sink.chunks.push(s);
      chars += s.length;
    }
    if (chars > sink.cap) onOverflow(which);
    if (sink.emit) {
      lineBuf += s;
      const parts = lineBuf.split(/[\r\n]/);
      lineBuf = parts.pop() ?? '';
      for (const line of parts) if (line.length !== 0) sink.emit(line);
    }
  });
}

function armTermination(
  child: ChildProcessWithoutNullStreams,
  state: ProcState,
  timeout_ms: number | undefined,
  signal: AbortSignal | undefined,
): () => void {
  const timer = timeout_ms
    ? setTimeout(() => {
        state.timedOut = true;
        child.kill('SIGTERM');
        scheduleSigkill(child, state);
      }, timeout_ms)
    : null;

  const onAbort = () => {
    state.aborted = true;
    child.kill('SIGTERM');
    scheduleSigkill(child, state);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  return () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    for (const t of state.sigkillTimers) clearTimeout(t);
    state.sigkillTimers.length = 0;
  };
}

function pipeStdin(child: ChildProcessWithoutNullStreams, stdin: string | Buffer | Readable | undefined): void {
  if (stdin === undefined) {
    child.stdin.end();
    return;
  }
  if (typeof stdin === 'string' || Buffer.isBuffer(stdin)) {
    child.stdin.end(stdin);
    return;
  }
  const src = stdin;
  child.stdin.on('error', () => {});
  src.on('error', () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
  // Force pipe teardown so 'close' isn't blocked on a writable the source will never drain into.
  child.on('exit', () => {
    src.unpipe(child.stdin);
    if (!child.stdin.destroyed) child.stdin.end();
    if (!src.destroyed) src.destroy();
  });
  src.pipe(child.stdin);
}

function awaitSettle(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const onClose = (code: number | null) => {
      done();
      resolve(code);
    };
    const onExit = (code: number | null) => {
      if (child.signalCode !== null) {
        done();
        resolve(code);
      }
    };
    const onError = (err: Error) => {
      done();
      reject(err);
    };
    const done = () => {
      child.removeListener('close', onClose);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    child.on('close', onClose);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

interface FinalizeCtx {
  cmd: string;
  args: readonly string[];
  opts: RunOptions;
  start: number;
  maxStdoutChars: number;
  maxStderrChars: number;
}

function finalize(code: number | null, state: ProcState, ctx: FinalizeCtx): RunResult {
  const { cmd, args, opts } = ctx;
  const fullCmd = [cmd, ...args].join(' ');
  const duration_ms = Date.now() - ctx.start;

  if (state.overflow !== null) {
    const cap = state.overflow === 'stdout' ? ctx.maxStdoutChars : ctx.maxStderrChars;
    logger.warn('exec output cap exceeded', { cmd, args, stream: state.overflow, cap, duration_ms });
    throw new CommandOutputTooLarge(fullCmd, state.overflow, cap);
  }
  if (state.aborted) {
    logger.warn('exec aborted', { cmd, args, duration_ms });
    throw new CommandAborted(fullCmd);
  }
  if (state.timedOut) {
    logger.warn('exec timed out', { cmd, args, timeout_ms: opts.timeout_ms, duration_ms });
    throw new CommandTimeout(fullCmd, opts.timeout_ms ?? 0);
  }

  const exit_code = code ?? -1;
  const stdout = state.stdoutChunks.join('');
  const stderr = state.stderrChunks.join('');
  if (exit_code !== 0) {
    const level = opts.quiet_nonzero ? 'debug' : 'warn';
    logger[level]('exec nonzero exit', { cmd, args, exit_code, duration_ms, stderr: stderr.slice(0, STDERR_LOG_CAP) });
  } else {
    logger.debug('exec complete', { cmd, args, exit_code, duration_ms, stdout_bytes: stdout.length });
  }
  return { stdout, stderr, exit_code, duration_ms };
}

export async function run(cmd: string, args: readonly string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const start = Date.now();
  const effectiveSignal = opts.signal ?? dispatchContext.getStore()?.signal;

  logger.debug('exec start', { cmd, args, timeout_ms: opts.timeout_ms });

  if (effectiveSignal?.aborted) {
    logger.warn('exec skipped — already aborted', { cmd, args });
    throw new CommandAborted([cmd, ...args].join(' '));
  }

  const maxStdoutChars = opts.max_stdout_chars ?? DEFAULT_MAX_STREAM_CHARS;
  const maxStderrChars = opts.max_stderr_chars ?? DEFAULT_MAX_STREAM_CHARS;

  const operation = dispatchContext.getStore()?.operation ?? '';
  const isCollector = operation.startsWith('collection.');
  const quietEffective = opts.quiet ?? isCollector;
  const defaultLogClass = basename(cmd) === 'chroot' && args.length >= 2 ? basename(args[1] ?? '') : basename(cmd);
  const lineLogger = quietEffective ? null : makeLogger(opts.log_class ?? defaultLogClass);
  const stdoutLevel: Level = opts.stdout_level ?? 'trace';
  const stderrLevel: Level = opts.stderr_level ?? 'trace';

  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });

  const state: ProcState = {
    stdoutChunks: [],
    stderrChunks: [],
    timedOut: false,
    aborted: false,
    overflow: null,
    sigkillTimers: [],
  };
  const onOverflow = (which: 'stdout' | 'stderr') => killForOverflow(child, state, which);

  const stdoutEmit =
    lineLogger !== null || opts.onStdoutLine !== undefined
      ? (line: string) => {
          if (lineLogger) lineLogger[stdoutLevel](line);
          opts.onStdoutLine?.(line);
        }
      : null;
  const stderrEmit =
    lineLogger !== null || opts.onStderrLine !== undefined
      ? (line: string) => {
          if (lineLogger) lineLogger[stderrLevel](line);
          opts.onStderrLine?.(line);
        }
      : null;

  collectStream(
    child.stdout,
    'stdout',
    { chunks: state.stdoutChunks, cap: maxStdoutChars, emit: stdoutEmit },
    state,
    onOverflow,
  );
  collectStream(
    child.stderr,
    'stderr',
    { chunks: state.stderrChunks, cap: maxStderrChars, emit: stderrEmit },
    state,
    onOverflow,
  );

  const cleanup = armTermination(child, state, opts.timeout_ms, effectiveSignal);
  pipeStdin(child, opts.stdin);

  try {
    let code: number | null;
    try {
      code = await awaitSettle(child);
    } catch (err) {
      logger.error('exec spawn error', { cmd, args, message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return finalize(code, state, { cmd, args, opts, start, maxStdoutChars, maxStderrChars });
  } finally {
    cleanup();
  }
}
