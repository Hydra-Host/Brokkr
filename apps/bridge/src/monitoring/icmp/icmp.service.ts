import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isIP } from 'node:net';
import { getErrorMessage } from '../../common/error-utils';

import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';

import { logDebug, logError, logWarning } from '../../core/logging/bridge-logger';
import type {
  IcmpBatchPingTestArgs,
  IcmpPingBatchResult,
  IcmpPingResult,
  IcmpPingTestArgs,
  IcmpService as IcmpServiceContract,
} from './icmp.types';

import { IcmpMonitoringError } from './icmp.types';

export { IcmpMonitoringError };

export interface PingMetrics {
  success: boolean;
  reachable: number;
  packet_loss: number;
  packets_sent: number;
  packets_received: number;
  rtt_min: number | null;
  rtt_avg: number | null;
  rtt_max: number | null;
  rtt_mdev: number | null;
  jitter?: number | null;
  error?: string;
}

export interface RttStats {
  rtt_min: number | null;
  rtt_avg: number | null;
  rtt_max: number | null;
  rtt_mdev: number;
  jitter: number | null;
}

export interface BatchPingTarget {
  ip: string;
  count?: number;
  timeout?: number;
  packet_size?: number;
}

export interface BatchPingResultSuccess {
  ip: string;
  status: 'success';
  metrics: {
    icmpping: number;
    icmppingloss: number;
    icmppingsec: number | null;
    'icmppingsec.min': number | null;
    'icmppingsec.max': number | null;
    'icmppingsec.avg': number | null;
  };
}

export interface BatchPingResultFailure {
  ip: string;
  status: 'failure' | 'error';
  error: string;
}

export type BatchPingResult = BatchPingResultSuccess | BatchPingResultFailure;

export interface BatchPingResponse {
  total_targets: number;
  successful: number;
  failed: number;
  results: BatchPingResult[];
}

const DANGEROUS_CHARS = new Set([';', '&', '|', '`', '$', '(', ')', '{', '}', '<', '>', '\n', '\r', '"', "'", '\\']);

const HOSTNAME_RE = /^[a-zA-Z0-9.-]+$/;

const PACKET_RE = /(\d+) packets transmitted, (\d+) (?:packets )?received(?:, \+(\d+) errors)?, ([\d.]+)% packet loss/m;

const RTT_RE = /(?:rtt|round-trip) min\/avg\/max\/(?:mdev|stddev) = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/m;

const PER_PACKET_RTT_RE = /time=([\d.]+) ms/;

const PING_BINARY_CANDIDATES = ['/usr/bin/ping', '/bin/ping', '/sbin/ping'];

export function resolvePingBinary(): string {
  for (const candidate of PING_BINARY_CANDIDATES) {
    try {
      accessSync(candidate, constants.F_OK | constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return 'ping';
}

let cachedPingBinary: string | null = null;

// mirrors ipmitoolBin(); the fallbacks differ (bare name vs PATH walk), so the two resolvers stay separate
export function pingBinary(): string {
  cachedPingBinary ??= resolvePingBinary();
  return cachedPingBinary;
}

export function resetPingBinary(): void {
  cachedPingBinary = null;
}

// bsd ping reads -W in milliseconds; iputils and busybox read seconds
function pingWaitArg(timeoutSeconds: number): string {
  return String(process.platform === 'darwin' ? timeoutSeconds * 1000 : timeoutSeconds);
}

function toInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return n;
  }
  return null;
}

function canonicalNumeric(value: number): number {
  return Number(value.toFixed(6));
}

function mean(samples: readonly number[]): number {
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

function sampleStdev(samples: readonly number[]): number {
  const m = mean(samples);
  let sq = 0;
  for (const s of samples) sq += (s - m) * (s - m);
  return Math.sqrt(sq / (samples.length - 1));
}

export function computeExtendedRttStats(allRtts: readonly number[]): RttStats {
  if (allRtts.length === 0) {
    return { rtt_min: null, rtt_avg: null, rtt_max: null, rtt_mdev: 0, jitter: null };
  }
  let rttMin = allRtts[0];
  let rttMax = allRtts[0];
  for (const r of allRtts) {
    if (r < rttMin) rttMin = r;
    if (r > rttMax) rttMax = r;
  }
  const rttAvg = mean(allRtts);

  let rttMdev: number;
  let jitter: number | null;
  if (allRtts.length > 1) {
    rttMdev = sampleStdev(allRtts);
    const diffs: number[] = [];
    for (let i = 1; i < allRtts.length; i++) {
      diffs.push(Math.abs(allRtts[i] - allRtts[i - 1]));
    }
    jitter = diffs.length > 0 ? mean(diffs) : 0;
  } else {
    rttMdev = 0;
    jitter = null;
  }

  return {
    rtt_min: canonicalNumeric(rttMin),
    rtt_avg: canonicalNumeric(rttAvg),
    rtt_max: canonicalNumeric(rttMax),
    rtt_mdev: canonicalNumeric(rttMdev),
    jitter: jitter === null ? null : canonicalNumeric(jitter),
  };
}

export function parsePingOutput(output: string, returnCode: number): PingMetrics {
  const metrics: PingMetrics = {
    success: true,
    reachable: 0,
    packet_loss: 100,
    packets_sent: 0,
    packets_received: 0,
    rtt_min: null,
    rtt_avg: null,
    rtt_max: null,
    rtt_mdev: null,
  };

  if (returnCode !== 0 && returnCode !== 1 && returnCode !== 2) {
    metrics.success = false;
    metrics.error = 'Ping command failed';
    return metrics;
  }

  const packetMatch = PACKET_RE.exec(output);
  if (packetMatch) {
    const sent = Number.parseInt(packetMatch[1], 10);
    const received = Number.parseInt(packetMatch[2], 10);
    const loss = Number.parseFloat(packetMatch[4]);
    if (Number.isFinite(sent) && Number.isFinite(received) && Number.isFinite(loss)) {
      metrics.packets_sent = sent;
      metrics.packets_received = received;
      metrics.packet_loss = canonicalNumeric(loss);
      if (loss < 100) metrics.reachable = 1;
    }
  }

  const rttMatch = RTT_RE.exec(output);
  if (rttMatch) {
    const min = Number.parseFloat(rttMatch[1]);
    const avg = Number.parseFloat(rttMatch[2]);
    const max = Number.parseFloat(rttMatch[3]);
    const mdev = Number.parseFloat(rttMatch[4]);
    if ([min, avg, max, mdev].every(Number.isFinite)) {
      metrics.rtt_min = canonicalNumeric(min);
      metrics.rtt_avg = canonicalNumeric(avg);
      metrics.rtt_max = canonicalNumeric(max);
      metrics.rtt_mdev = canonicalNumeric(mdev);
    }
  }

  return metrics;
}

export function formatPingResponse(metrics: PingMetrics, targetIp: string, extendedMetrics = false): IcmpPingResult {
  if (!metrics.success) {
    return {
      result: 'failure',
      error: metrics.error ?? 'Ping failed',
      target_ip: targetIp,
      metrics: {
        icmpping: 0,
        icmppingloss: 100,
        icmppingsec: null,
        'icmppingsec.min': null,
        'icmppingsec.max': null,
        'icmppingsec.avg': null,
      },
    };
  }

  const toSeconds = (ms: number | null): number | null => (ms === null ? null : canonicalNumeric(ms / 1000));

  const response: IcmpPingResult = {
    result: 'success',
    target_ip: targetIp,
    metrics: {
      icmpping: metrics.reachable,
      icmppingloss: metrics.packet_loss,
      icmppingsec: toSeconds(metrics.rtt_avg),
      'icmppingsec.min': toSeconds(metrics.rtt_min),
      'icmppingsec.max': toSeconds(metrics.rtt_max),
      'icmppingsec.avg': toSeconds(metrics.rtt_avg),
      packets_sent: metrics.packets_sent,
      packets_received: metrics.packets_received,
      rtt_mdev_ms: metrics.rtt_mdev,
    },
  };

  if (extendedMetrics && 'jitter' in metrics && metrics.jitter !== null && metrics.jitter !== undefined) {
    response.metrics.jitter_ms = metrics.jitter;
  }

  return response;
}

@Injectable()
export class IcmpService implements IcmpServiceContract {
  private readonly jobId: string;

  constructor(jobId = '') {
    this.jobId = jobId;
  }

  validateIpAddress(ipString: string): string {
    if (!ipString) {
      throw new Error('IP address cannot be empty');
    }
    const trimmed = ipString.trim();
    for (const ch of trimmed) {
      if (DANGEROUS_CHARS.has(ch)) {
        throw new Error('IP address contains invalid characters');
      }
    }
    if (isIP(trimmed) !== 0) {
      return trimmed;
    }
    if (!HOSTNAME_RE.test(trimmed)) {
      throw new Error('Invalid hostname format');
    }
    if (trimmed.length > 253) {
      throw new Error('Hostname too long');
    }
    if (trimmed.startsWith('-') || trimmed.endsWith('-')) {
      throw new Error('Hostname cannot start or end with hyphen');
    }
    if (trimmed.includes('..')) {
      throw new Error('Invalid hostname format');
    }
    return trimmed;
  }

  validatePingParameters(
    count: unknown,
    timeout: unknown,
    packetSize: unknown,
    interval: unknown,
  ): [number, number, number, number] {
    const c = toInt(count);
    if (c === null) throw new Error('Invalid count value');
    if (c < 1 || c > 100) throw new Error('Count must be between 1 and 100');

    const t = toInt(timeout);
    if (t === null) throw new Error('Invalid timeout value');
    if (t < 1 || t > 30) throw new Error('Timeout must be between 1 and 30 seconds');

    const p = toInt(packetSize);
    if (p === null) throw new Error('Invalid packet size value');
    if (p < 0 || p > 65507) throw new Error('Packet size must be between 0 and 65507 bytes');

    const i = toInt(interval);
    if (i === null) throw new Error('Invalid interval value');
    if (i < 0 || i > 10000) throw new Error('Interval must be between 0 and 10000 milliseconds');

    return [c, t, p, i];
  }

  parsePingOutput(output: string, returnCode: number): PingMetrics {
    return parsePingOutput(output, returnCode);
  }

  formatPingResponse(metrics: PingMetrics, targetIp: string, extendedMetrics = false): IcmpPingResult {
    return formatPingResponse(metrics, targetIp, extendedMetrics);
  }

  async runPingCommandSecure(ip: string, count: number, timeout: number, packetSize: number): Promise<PingMetrics> {
    const command = [
      'timeout',
      '--preserve-status',
      `${timeout * count + 1}s`,
      pingBinary(),
      '-c',
      String(count),
      '-W',
      pingWaitArg(timeout),
      '-s',
      String(packetSize),
      '-q',
      ip,
    ];

    logDebug(
      `Executing ping command for IP: ${ip} - count: ${count}, timeout: ${timeout}, packet_size: ${packetSize}`,
      { jobId: this.jobId },
    );
    logDebug(`Running ping command for IP: ${ip}`, { jobId: this.jobId });

    const fail = (error: string): PingMetrics => ({
      success: false,
      reachable: 0,
      packet_loss: 100,
      packets_sent: 0,
      packets_received: 0,
      rtt_min: null,
      rtt_avg: null,
      rtt_max: null,
      rtt_mdev: null,
      error,
    });

    try {
      const { stdout, returnCode } = await runSubprocess(command, (timeout * count + 2) * 1000);
      let output = stdout;
      if (output.length > 10000) {
        output = output.slice(0, 10000) + '\n... (truncated)';
      }
      logDebug(`Ping command completed with return code: ${returnCode}, parsing output`, { jobId: this.jobId });
      const metrics = parsePingOutput(output, returnCode);
      logDebug(`Ping metrics parsed: reachable=${metrics.reachable}, packet_loss=${metrics.packet_loss}%`, {
        jobId: this.jobId,
      });
      logDebug(`Ping completed for ${ip}, reachable: ${metrics.reachable}`, {
        jobId: this.jobId,
      });
      return metrics;
    } catch (error) {
      if (error instanceof SubprocessTimeoutError) {
        logError(`Ping command timed out for ${ip}`, { jobId: this.jobId });
        return fail('Command timed out');
      }
      logError(`Ping command failed for ${ip}: ${getErrorMessage(error)}`, {
        jobId: this.jobId,
      });
      return fail('Internal error');
    }
  }

  async runExtendedPingSecure(
    ip: string,
    count: number,
    timeout: number,
    packetSize: number,
    interval: number,
  ): Promise<PingMetrics> {
    const allRtts: number[] = [];
    let totalSent = 0;
    let totalReceived = 0;
    const actualCount = Math.min(count, 20);

    for (let i = 0; i < actualCount; i++) {
      const command = [
        'timeout',
        '--preserve-status',
        `${timeout + 1}s`,
        pingBinary(),
        '-c',
        '1',
        '-W',
        pingWaitArg(timeout),
        '-s',
        String(packetSize),
        ip,
      ];

      try {
        const { stdout, returnCode } = await runSubprocess(command, (timeout + 2) * 1000);
        totalSent += 1;
        const rttMatch = PER_PACKET_RTT_RE.exec(stdout);
        if (rttMatch && returnCode === 0) {
          const value = Number.parseFloat(rttMatch[1]);
          if (Number.isFinite(value) && value >= 0 && value <= 10000) {
            allRtts.push(value);
            totalReceived += 1;
          }
        }
        if (interval > 0 && i < actualCount - 1) {
          await sleep(Math.min(interval / 1000, 1) * 1000);
        }
      } catch (error) {
        if (error instanceof SubprocessTimeoutError) {
          logWarning(`Individual ping ${i + 1} timed out`, { jobId: this.jobId });
        } else {
          logWarning(`Individual ping ${i + 1} failed: ${getErrorMessage(error)}`, {
            jobId: this.jobId,
          });
        }
        continue;
      }
    }

    const packetLoss = totalSent > 0 ? ((totalSent - totalReceived) / totalSent) * 100 : 100;
    const stats = computeExtendedRttStats(allRtts);

    return {
      success: true,
      reachable: totalReceived > 0 ? 1 : 0,
      packet_loss: packetLoss,
      packets_sent: totalSent,
      packets_received: totalReceived,
      rtt_min: stats.rtt_min,
      rtt_avg: stats.rtt_avg,
      rtt_max: stats.rtt_max,
      rtt_mdev: stats.rtt_mdev,
      jitter: stats.jitter,
    };
  }

  async executePingTest(args: IcmpPingTestArgs): Promise<IcmpPingResult> {
    const { ip, count = 5, timeout = 3, packetSize = 56, interval = 1000, extendedMetrics = false } = args;
    logDebug(`Starting ping test for IP: ${ip} with extended_metrics: ${extendedMetrics}`, {
      jobId: this.jobId,
    });
    const validatedIp = this.validateIpAddress(ip);
    const [c, t, p, iv] = this.validatePingParameters(count, timeout, packetSize, interval);
    logDebug(`Parameters validated: ip=${validatedIp}, count=${c}, timeout=${t}, packet_size=${p}, interval=${iv}`, {
      jobId: this.jobId,
    });

    try {
      const metrics = extendedMetrics
        ? await this.runExtendedPingSecure(validatedIp, c, t, p, iv)
        : await this.runPingCommandSecure(validatedIp, c, t, p);
      return formatPingResponse(metrics, validatedIp, extendedMetrics);
    } catch (error) {
      logError(`Ping test failed: ${getErrorMessage(error)}`, { jobId: this.jobId });
      throw new Error('Internal error during ping test');
    }
  }

  async executeBatchPingTest(args: IcmpBatchPingTestArgs): Promise<IcmpPingBatchResult> {
    const { targets, defaultCount = 5, defaultTimeout = 3, defaultPacketSize = 56 } = args;
    if (targets.length > 50) {
      throw new Error('Maximum 50 targets per batch');
    }

    const [dCount, dTimeout, dPacketSize] = this.validatePingParameters(
      defaultCount,
      defaultTimeout,
      defaultPacketSize,
      1000,
    );

    const tasks: Array<{ ip: string; promise: Promise<PingMetrics> }> = [];
    for (const target of targets.slice(0, 50)) {
      if (!isRecord(target) || !('ip' in target)) {
        logWarning(`Skipping invalid target: ${JSON.stringify(target)}`, {
          jobId: this.jobId,
        });
        continue;
      }
      try {
        const ip = this.validateIpAddress(String(target.ip));
        const [c, t, p] = this.validatePingParameters(
          target.count ?? dCount,
          target.timeout ?? dTimeout,
          target.packet_size ?? dPacketSize,
          1000,
        );
        tasks.push({ ip, promise: this.runPingCommandSecure(ip, c, t, p) });
      } catch (error) {
        logWarning(`Skipping target due to validation error: ${getErrorMessage(error)}`, {
          jobId: this.jobId,
        });
        continue;
      }
    }

    const maxConcurrent = 10;
    const results: BatchPingResult[] = [];

    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const batch = tasks.slice(i, i + maxConcurrent);
      const settled = await Promise.allSettled(batch.map((t) => t.promise));
      for (let j = 0; j < batch.length; j++) {
        const { ip } = batch[j];
        const res = settled[j];
        if (res.status === 'rejected') {
          results.push({ ip, status: 'error', error: 'Execution failed' });
          continue;
        }
        const value = res.value;
        if (value.success) {
          const toSeconds = (ms: number | null): number | null => (ms === null ? null : canonicalNumeric(ms / 1000));
          results.push({
            ip,
            status: 'success',
            metrics: {
              icmpping: value.reachable,
              icmppingloss: value.packet_loss,
              icmppingsec: toSeconds(value.rtt_avg),
              'icmppingsec.min': toSeconds(value.rtt_min),
              'icmppingsec.max': toSeconds(value.rtt_max),
              'icmppingsec.avg': toSeconds(value.rtt_avg),
            },
          });
        } else {
          results.push({ ip, status: 'failure', error: value.error ?? 'Ping failed' });
        }
      }
    }

    return {
      total_targets: results.length,
      successful: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status !== 'success').length,
      results: results.map((r) => ({ ...r }) as Record<string, unknown>),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SubprocessTimeoutError extends Error {
  override name = 'SubprocessTimeoutError';
}

interface SubprocessResult {
  stdout: string;
  returnCode: number;
}

function runSubprocess(argv: readonly string[], timeoutMs: number): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new SubprocessTimeoutError('subprocess timed out'));
        return;
      }
      const stdout = Buffer.concat(chunks).toString('utf-8');
      const returnCode = code !== null ? code : signal !== null ? -1 : 0;
      resolve({ stdout, returnCode });
    });
  });
}

export function createIcmpService(jobId = ''): IcmpService {
  return new IcmpService(jobId);
}
