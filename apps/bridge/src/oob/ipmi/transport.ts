import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

import { Logger } from '@nestjs/common';

import type { IPMIResult } from './result.js';

const logger = new Logger('adapter-ipmi-transport');
const STDOUT_TRUNCATE = 1_000_000;
const STDERR_TRUNCATE = 10_000;

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function redact(command: readonly string[], password: string): string[] {
  if (!password) return [...command];
  return command.map((arg) => (constantTimeEquals(arg, password) ? 'XXXXXXXXXXXXXX' : arg));
}

function formatCommandArgs(items: readonly string[]): string {
  return JSON.stringify(items);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n... (truncated)';
}

export interface IPMITransportOptions {
  cipherUsed?: string | null;
  jobId?: string;
}

const LOSSY_DECODER = new TextDecoder('utf-8', { fatal: false });

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: Error | null;
}

async function spawnLossy(cmd: readonly string[], timeoutSec: number): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    const [bin, ...args] = cmd;
    if (bin === undefined) {
      resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: new Error('Command is empty') });
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let spawnError: Error | null = null;
    let timer: NodeJS.Timeout | null = null;
    if (timeoutSec !== 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutSec * 1000);
    }
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdout = LOSSY_DECODER.decode(Buffer.concat(stdoutChunks));
      const stderr = LOSSY_DECODER.decode(Buffer.concat(stderrChunks));
      resolve({ stdout, stderr, exitCode: code, timedOut, spawnError });
    });
  });
}

export async function run(
  command: readonly string[],
  password: string,
  timeout: number,
  opts: IPMITransportOptions = {},
): Promise<IPMIResult> {
  const cipherUsed = opts.cipherUsed ?? null;
  const jobId = opts.jobId ?? '';
  const redacted = redact(command, password);
  logger.debug(`ipmitool: ${formatCommandArgs(redacted)} (timeout=${timeout}s)`, jobId);
  const start = Date.now();
  // `timeout --preserve-status` SIGTERMs a hung ipmitool; outer deadline timeout+1s wins if timeout(1) itself wedges.
  const wrapped: string[] = ['timeout', '--preserve-status', `${timeout}s`, ...command];

  let outcome: SpawnOutcome;
  try {
    outcome = await spawnLossy(wrapped, timeout + 1);
  } catch (e) {
    const durationMs = Date.now() - start;
    logger.error(`ipmitool transport error: ${e instanceof Error ? e.message : String(e)}`, jobId);
    return {
      ok: false,
      stdout: '',
      stderr: 'Internal error',
      returncode: null,
      command: [...command],
      cipherUsed,
      durationMs,
      timedOut: false,
    };
  }

  const durationMs = Date.now() - start;
  if (outcome.timedOut) {
    logger.error(`ipmitool timed out after ${timeout}s`, jobId);
    return {
      ok: false,
      stdout: '',
      stderr: 'Command timed out',
      returncode: null,
      command: [...command],
      cipherUsed,
      durationMs,
      timedOut: true,
    };
  }
  if (outcome.spawnError) {
    logger.error(`ipmitool transport error: ${outcome.spawnError.message}`, jobId);
    return {
      ok: false,
      stdout: '',
      stderr: 'Internal error',
      returncode: null,
      command: [...command],
      cipherUsed,
      durationMs,
      timedOut: false,
    };
  }

  const stdout = truncate(outcome.stdout.replace(/\n+$/, ''), STDOUT_TRUNCATE);
  const stderr = truncate(outcome.stderr.replace(/\n+$/, ''), STDERR_TRUNCATE);
  const ok = outcome.exitCode === 0;
  if (!ok) {
    logger.error(`ipmitool failed rc=${outcome.exitCode}: ${stderr.slice(0, 200)}`, jobId);
  }
  return {
    ok,
    stdout,
    stderr,
    returncode: outcome.exitCode,
    command: [...command],
    cipherUsed,
    durationMs,
    timedOut: false,
  };
}
