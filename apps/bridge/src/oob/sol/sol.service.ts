import { performance } from 'node:perf_hooks';

import { Injectable } from '@nestjs/common';

import { getErrorMessage } from '../../common/error-utils';
import { validateIp, validateUsername } from '../ipmi/validation.js';

import type {
  IPMIDevice,
  SolCache,
  SolCipherFn,
  SolDeactivateFn,
  SolLogger,
  SolPingFn,
  SolStream,
  SolStreamFactory,
} from './sol.types';

export const SOL_LOG_TTL = 86400;

const FLUSH_INTERVAL = 5;
const FLUSH_BATCH_SIZE = 50;

const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g');
const STRAY_CSI = `${ESC}[01;01`;
const NUL = '\0';
const BACKSPACE = '\b';

export function solLogKey(planId: string): string {
  return `sol:logs:${planId}`;
}

export function decodeUtf8Ignore(buf: Buffer): string {
  let out = '';
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b0 = buf[i] as number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    let seqLen = 0;
    let codepoint = 0;
    let minCp = 0;
    if ((b0 & 0xe0) === 0xc0) {
      seqLen = 2;
      codepoint = b0 & 0x1f;
      minCp = 0x80;
    } else if ((b0 & 0xf0) === 0xe0) {
      seqLen = 3;
      codepoint = b0 & 0x0f;
      minCp = 0x800;
    } else if ((b0 & 0xf8) === 0xf0) {
      seqLen = 4;
      codepoint = b0 & 0x07;
      minCp = 0x10000;
    } else {
      i += 1;
      continue;
    }
    if (i + seqLen > n) {
      i += 1;
      continue;
    }
    let valid = true;
    for (let k = 1; k < seqLen; k += 1) {
      const bk = buf[i + k] as number;
      if ((bk & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codepoint = (codepoint << 6) | (bk & 0x3f);
    }
    if (!valid || codepoint < minCp || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
      i += 1;
      continue;
    }
    if (codepoint <= 0xffff) {
      out += String.fromCharCode(codepoint);
    } else {
      const offset = codepoint - 0x10000;
      const hi = 0xd800 + (offset >> 10);
      const lo = 0xdc00 + (offset & 0x3ff);
      out += String.fromCharCode(hi, lo);
    }
    i += seqLen;
  }
  return out;
}

export function processBackspaces(text: string): string {
  const result: string[] = [];
  for (const char of text) {
    if (char === BACKSPACE) {
      if (result.length > 0) {
        result.pop();
      }
    } else {
      result.push(char);
    }
  }
  return result.join('');
}

export function processControlChars(text: string): string {
  let out = processBackspaces(text);
  out = out.replace(ANSI_RE, '');
  out = out.split(STRAY_CSI).join('');
  out = out.split(NUL).join('');
  return out;
}

export function detectSolKeyword(
  buffer: string,
  passStrings: readonly string[],
  failStrings: readonly string[],
): 'pass' | 'fail' | null {
  if (passStrings.some((kw) => buffer.includes(kw))) {
    return 'pass';
  }
  if (failStrings.some((kw) => buffer.includes(kw))) {
    return 'fail';
  }
  return null;
}

export function localIsoTimestamp(date?: Date): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');

  let d: Date;
  let micros: number;
  if (date === undefined) {
    const nowMs = performance.timeOrigin + performance.now();
    const floorMs = Math.floor(nowMs);
    d = new Date(floorMs);
    const subMs = nowMs - floorMs;
    micros = d.getMilliseconds() * 1000 + Math.floor(subMs * 1000);
  } else {
    d = date;
    micros = date.getMilliseconds() * 1000;
  }

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1, 2);
  const day = pad(d.getDate(), 2);
  const hour = pad(d.getHours(), 2);
  const minute = pad(d.getMinutes(), 2);
  const second = pad(d.getSeconds(), 2);
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (micros === 0) {
    return base;
  }
  return `${base}.${pad(micros, 6)}`;
}

function coercePort(value: unknown, fallback = 623): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      return Math.trunc(Number(trimmed));
    }
    throw new TypeError(`invalid literal for int() with base 10: '${value}'`);
  }
  throw new TypeError(
    `int() argument must be a string, a bytes-like object or a real number, not '${value === null ? 'NoneType' : typeof value}'`,
  );
}

function coerceTimeout(value: unknown, fallback = 300): number {
  if (value === undefined) return fallback;
  if (value === null) return Number.POSITIVE_INFINITY;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function coerceTimeoutStrict(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new TypeError(`probeForTokens: timeout must be a finite number or numeric string; received ${typeof value}`);
}

function coerceStringList(value: unknown, fallback: string[]): string[] {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    return Array.from(value);
  }
  throw new TypeError(`'${value === null ? 'NoneType' : typeof value}' object is not iterable`);
}

function coerceOptionalString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

export interface SOLServiceDeps {
  cache: SolCache;
  getCipher: SolCipherFn;
  solDeactivateFn: SolDeactivateFn;
  pingFn: SolPingFn;
  streamFactory: SolStreamFactory;
  logger: SolLogger;
  nowFn?: () => number;
}

export interface ScanStreamParams {
  tokens: readonly string[];
  stream: AsyncIterable<Buffer>;
  timeout: number;
}

export interface ProbeForTokensParams {
  ipAddress: string;
  username: string;
  password: string;
  tokens: string[];
  timeout: number | string;
  port?: unknown;
  deviceId?: unknown;
}

export interface DeactivateSessionParams {
  ipAddress: string;
  username: string;
  password: string;
  port?: unknown;
  deviceId?: unknown;
}

export interface MonitorSessionParams {
  planId: string;
  ipAddress: string;
  username: string;
  password: string;
  port?: unknown;
  timeout?: unknown;
  passStrings?: unknown;
  failStrings?: unknown;
  deviceId?: unknown;
}

@Injectable()
export class SOLService {
  private readonly jobId: string;
  private readonly cache: SolCache;
  private readonly getCipher: SolCipherFn;
  private readonly solDeactivateFn: SolDeactivateFn;
  private readonly pingFn: SolPingFn;
  private readonly streamFactory: SolStreamFactory;
  private readonly logger: SolLogger;
  private readonly nowFn: () => number;

  constructor(jobId: string, deps: SOLServiceDeps) {
    this.jobId = jobId;
    this.cache = deps.cache;
    this.getCipher = deps.getCipher;
    this.solDeactivateFn = deps.solDeactivateFn;
    this.pingFn = deps.pingFn;
    this.streamFactory = deps.streamFactory;
    this.logger = deps.logger;
    this.nowFn = deps.nowFn ?? (() => Number(process.hrtime.bigint()) / 1e9);
  }

  private async flushLogsToRedis(planId: string, entries: readonly Record<string, string>[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const key = solLogKey(planId);
    try {
      const serialized = entries.map((e) => JSON.stringify(e));
      await this.cache.rpush(key, serialized, this.jobId);
      await this.cache.expire(key, SOL_LOG_TTL, this.jobId);
    } catch (e) {
      await this.logger.warning(`Failed to flush SOL logs to Redis: ${getErrorMessage(e)}`, {
        jobId: this.jobId,
      });
    }
  }

  async scanStream(params: ScanStreamParams): Promise<Record<string, unknown>> {
    const { tokens, stream, timeout } = params;
    const start = this.nowFn();
    let buffer = '';
    let linesSeen = 0;
    const matches: { token: string; at_seconds: number }[] = [];
    const seenTokens = new Set<string>();
    const maxTokenLen = tokens.length > 0 ? Math.max(...tokens.map((t) => t.length)) : 0;
    let error: string | null = null;

    try {
      for await (const chunk of stream) {
        if (this.nowFn() - start > timeout) {
          break;
        }

        const decoded = decodeUtf8Ignore(chunk);
        buffer += decoded;
        linesSeen += countChar(decoded, '\n');

        const positions: [number, string][] = [];
        for (const token of tokens) {
          if (seenTokens.has(token)) {
            continue;
          }
          const idx = buffer.indexOf(token);
          if (idx >= 0) {
            positions.push([idx, token]);
          }
        }
        positions.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        const nowS = roundTo3(this.nowFn() - start);
        for (const [, token] of positions) {
          matches.push({ token, at_seconds: nowS });
          seenTokens.add(token);
        }

        if (matches.length > 0) {
          break;
        }

        const cap = maxTokenLen * 4;
        if (cap > 0 && codePointLength(buffer) > cap) {
          buffer = sliceCodePointsTail(buffer, maxTokenLen * 2);
        }
      }
    } catch (exc) {
      error = getErrorMessage(exc);
    }

    return {
      matches,
      lines_seen: linesSeen,
      duration_seconds: roundTo3(this.nowFn() - start),
      error,
    };
  }

  private async resolveIpmiDevice(
    ipAddress: string,
    username: string,
    password: string,
    port: unknown = 623,
    deviceId: string | null = null,
  ): Promise<IPMIDevice> {
    const validatedIp = validateIp(ipAddress);
    const validatedUsername = validateUsername(username);
    const base: IPMIDevice = {
      ip: validatedIp,
      username: validatedUsername,
      password,
      port: coercePort(port),
      cipher: null,
      jobId: this.jobId,
    };
    const cipher = await this.getCipher(base, deviceId);
    return { ...base, cipher };
  }

  async probeForTokens(params: ProbeForTokensParams): Promise<Record<string, unknown>> {
    const { ipAddress, username, password, tokens } = params;
    // Port coercion must stay lazy so a bad port surfaces through the try/catch envelopes below.
    const port = params.port;
    const deviceId = coerceOptionalString(params.deviceId);

    await this.logger.info(
      `Starting SOL token probe for ${ipAddress} (${tokens.length} tokens, timeout=${String(params.timeout)}s)`,
      { jobId: this.jobId },
    );

    await this.deactivateSession({ ipAddress, username, password, port, deviceId });

    let inner: SolStream | null = null;
    const resolveDevice = () => this.resolveIpmiDevice(ipAddress, username, password, port, deviceId);
    const createStream = (device: IPMIDevice) => this.streamFactory(device);
    const deferred: SolStream = (async function* deferredStream() {
      const device = await resolveDevice();
      inner = createStream(device);
      yield* inner;
    })();

    let result: Record<string, unknown>;
    try {
      const timeout = coerceTimeoutStrict(params.timeout);
      try {
        result = await this.scanStream({ tokens, stream: deferred, timeout });
      } finally {
        if (inner !== null) {
          await inner.return(undefined);
        }
        await deferred.return(undefined);
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      await this.logger.warning(`SOL token probe error: ${msg}`, { jobId: this.jobId });
      result = { matches: [], lines_seen: 0, duration_seconds: 0.0, error: msg };
    } finally {
      await this.deactivateSession({ ipAddress, username, password, port, deviceId });
    }

    const matchesRaw = result['matches'];
    const matchCount = Array.isArray(matchesRaw) ? matchesRaw.length : 0;
    await this.logger.info(`SOL token probe complete for ${ipAddress}: ${matchCount} matches`, {
      jobId: this.jobId,
    });

    return result;
  }

  async deactivateSession(params: DeactivateSessionParams): Promise<Record<string, unknown>> {
    const { ipAddress, username, password } = params;
    const deviceId = coerceOptionalString(params.deviceId);

    try {
      const port = coercePort(params.port);
      const device = await this.resolveIpmiDevice(ipAddress, username, password, port, deviceId);
      await this.logger.info('Deactivating existing SOL session', { jobId: this.jobId });
      const result = await this.solDeactivateFn(device);
      if (result.timedOut) {
        await this.logger.warning('SOL deactivation timed out', { jobId: this.jobId });
      }
      return { deactivated: true };
    } catch (e) {
      const msg = getErrorMessage(e);
      await this.logger.warning(`SOL deactivation error (non-fatal): ${msg}`, {
        jobId: this.jobId,
      });
      return { deactivated: false, error: msg };
    }
  }

  async monitorSession(params: MonitorSessionParams): Promise<Record<string, unknown>> {
    const { planId, ipAddress, username, password } = params;
    const port = coercePort(params.port);
    const timeout = coerceTimeout(params.timeout);
    const passStrings = coerceStringList(params.passStrings, [' login:']);
    const failStrings = coerceStringList(params.failStrings, ['timeout', 'grub>']);
    const deviceId = coerceOptionalString(params.deviceId);

    const pingResult = (await this.pingFn(ipAddress, port, this.jobId)) as unknown;
    const pingFailed =
      pingResult === false ||
      (typeof pingResult === 'object' &&
        pingResult !== null &&
        (pingResult as Record<string, unknown>)['result'] === 'failure');
    if (pingFailed) {
      await this.logger.warning(`BMC ${ipAddress} unreachable, skipping SOL session`, {
        jobId: this.jobId,
      });
      return { detected: false, log_count: 0, skipped: true, reason: 'BMC unreachable' };
    }

    const device = await this.resolveIpmiDevice(ipAddress, username, password, port, deviceId);

    const timeoutLogStr = Number.isFinite(timeout) ? `${timeout}` : 'None';
    await this.logger.info(`Starting SOL session for ${ipAddress}, timeout=${timeoutLogStr}s`, {
      jobId: this.jobId,
    });

    let buffer = '';
    let pendingEntries: Record<string, string>[] = [];
    let totalLogCount = 0;
    let lastFlushTime = this.nowFn();

    pendingEntries.push({
      timestamp: localIsoTimestamp(),
      message: 'BEGIN LOG COLLECTION',
    });

    let detected: boolean | null = null;
    const stream: SolStream = this.streamFactory(device);

    try {
      await this.logger.info('SOL session activated, monitoring output', { jobId: this.jobId });
      let lastActivity = this.nowFn();

      while (true) {
        try {
          const next = await stream.next();
          if (next.done === true) {
            break;
          }
          const output = next.value;
          if (output.length === 0) {
            if (this.nowFn() - lastActivity > timeout) {
              await this.logger.warning('SOL session timed out', { jobId: this.jobId });
              detected = false;
              break;
            }
            continue;
          }

          const decoded = decodeUtf8Ignore(output);
          buffer += decoded;

          while (buffer.includes('\n')) {
            const splitIdx = buffer.indexOf('\n');
            const line = buffer.slice(0, splitIdx);
            buffer = buffer.slice(splitIdx + 1);
            const processed = processControlChars(line);

            if (processed.trim() !== '') {
              if (!processed.includes('[SOL Session operational.  Use ~? for help]')) {
                pendingEntries.push({
                  timestamp: localIsoTimestamp(),
                  message: processed.trim(),
                });
                totalLogCount += 1;
              }

              await this.logger.info(processed.trim(), {
                jobId: this.jobId,
                app_class_name: 'sol-logs',
              });
            }
          }

          lastActivity = this.nowFn();
          const processedBuffer = processControlChars(buffer);

          const keywordResult = detectSolKeyword(processedBuffer, passStrings, failStrings);
          if (keywordResult === 'pass') {
            await this.logger.info('Pass condition detected', { jobId: this.jobId });
            detected = true;
            break;
          }
          if (keywordResult === 'fail') {
            await this.logger.info('Fail condition detected', { jobId: this.jobId });
            detected = false;
            break;
          }

          const now = this.nowFn();
          if (pendingEntries.length >= FLUSH_BATCH_SIZE || now - lastFlushTime >= FLUSH_INTERVAL) {
            await this.flushLogsToRedis(planId, pendingEntries);
            pendingEntries = [];
            lastFlushTime = now;
          }
        } catch (e) {
          await this.logger.error(`Error reading SOL output: ${getErrorMessage(e)}`, {
            jobId: this.jobId,
          });
          detected = false;
          break;
        }
      }
    } finally {
      if (buffer !== '') {
        const processed = processControlChars(buffer);
        if (processed.trim() !== '') {
          pendingEntries.push({
            timestamp: localIsoTimestamp(),
            message: processed.trim(),
          });
          totalLogCount += 1;
        }
      }

      pendingEntries.push({
        timestamp: localIsoTimestamp(),
        message: 'END LOG COLLECTION',
      });

      await this.flushLogsToRedis(planId, pendingEntries);

      try {
        await stream.return(undefined);
      } catch (e) {
        await this.logger.debug(`Cleaning up SOL stream: ${getErrorMessage(e)}`, {
          jobId: this.jobId,
        });
      }
    }

    if (detected === null) {
      detected = false;
    }

    await this.logger.info(`SOL session complete: detected=${String(detected)}, log_count=${totalLogCount}`, {
      jobId: this.jobId,
    });

    return {
      detected,
      log_count: totalLogCount,
    };
  }
}

export async function createSolService(jobId: string, deps: SOLServiceDeps): Promise<SOLService> {
  return new SOLService(jobId, deps);
}

function countChar(s: string, ch: string): number {
  let count = 0;
  let idx = s.indexOf(ch);
  while (idx !== -1) {
    count += 1;
    idx = s.indexOf(ch, idx + 1);
  }
  return count;
}

function roundTo3(value: number): number {
  return Number(value.toFixed(3));
}

function codePointLength(s: string): number {
  let n = 0;

  for (const _ of s) n += 1;
  return n;
}

function sliceCodePointsTail(s: string, n: number): string {
  if (n <= 0) return '';
  const points: string[] = [];
  for (const ch of s) points.push(ch);
  if (points.length <= n) return s;
  return points.slice(points.length - n).join('');
}
