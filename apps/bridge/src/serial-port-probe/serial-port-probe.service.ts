import { randomUUID } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';
import { isRecord } from '@repo/utils';

import type { LoggerLike } from '../logger/logger.service';

import { buildResolved } from './serial-port-helpers';

export const AGENT_COLLECT_TIMEOUT_S = 20.0;
export const PROBE_SOL_WARMUP_S = 2.0;
export const AGENT_SETTLE_MS = 1500;
export const PER_PORT_WRITE_BUDGET_S = 12.0;
export const WRITE_BASE_OVERHEAD_S = 5.0 + AGENT_SETTLE_MS / 1000.0;
export const SOL_GRACE_S = 5.0;
export const OVERALL_GRACE_S = 10.0;

export function writeTimeout(numCandidates: number): number {
  return WRITE_BASE_OVERHEAD_S + PER_PORT_WRITE_BUDGET_S * Math.max(numCandidates, 1);
}

export function solProbeTimeout(writeTimeoutS: number): number {
  return PROBE_SOL_WARMUP_S + writeTimeoutS + SOL_GRACE_S;
}

export function overallGuard(solProbeTimeoutS: number): number {
  return AGENT_COLLECT_TIMEOUT_S + solProbeTimeoutS + OVERALL_GRACE_S;
}

export type DispatchFn = <N extends OperationName>(
  deviceId: string,
  opName: N,
  payload: Record<string, unknown>,
  options: { jobId: string; timeoutS: number },
) => Promise<OperationOutput<N>>;

export class SerialPortProbeError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'SerialPortProbeError';
  }
}

export interface SerialPortProbeResult {
  port: string | null;
  baud: unknown;
  source: string;
  confirmed: boolean;
  notes: string[];
  candidates: string[];
  error?: string;
  matched_at_seconds?: number | null;
  agent_writes?: unknown;
  probe_duration_seconds?: number | null;
  write_error?: string;
  probe_error?: string;
}

export function emptyResult(error: string, options?: { candidates?: string[] | null }): SerialPortProbeResult {
  return {
    port: null,
    baud: null,
    source: 'none',
    confirmed: false,
    notes: [],
    candidates: options?.candidates ?? [],
    error,
  };
}

export function activeCandidates(detectedPorts: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [name, info] of Object.entries(detectedPorts)) {
    if (
      info !== null &&
      typeof info === 'object' &&
      !Array.isArray(info) &&
      (info as Record<string, unknown>)['hardware_status'] === 'active' &&
      (info as Record<string, unknown>)['physically_accessible'] !== false
    ) {
      out.push(name);
    }
  }
  return out;
}

export interface SolProbeMatch {
  token?: string;
  at_seconds?: number;
}

export interface SolProbeResult {
  matches: SolProbeMatch[];
  lines_seen?: number;
  duration_seconds?: number | null;
  error?: string | null;
}

export interface SolProbeServiceLike {
  probeForTokens(params: {
    ipAddress: string;
    username: string;
    password: string;
    tokens: string[];
    timeout: number;
    port: number;
    deviceId: string;
  }): Promise<SolProbeResult>;
}

export interface SerialPortProbeDeps {
  solService?: SolProbeServiceLike;
  dispatchFn?: DispatchFn;
  logger?: LoggerLike;
  sleep?: (ms: number) => Promise<void>;
}

interface ProbeArgs {
  deviceId: string;
  bmcIp: string;
  bmcUsername: string;
  bmcPassword: string;
  bmcPort?: number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

@Injectable()
export class SerialPortProbeService {
  private readonly jobId: string;
  private solService: SolProbeServiceLike | null;
  private dispatchFn: DispatchFn | null;
  private readonly logger: LoggerLike | null;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private probeTask: Promise<SolProbeResult> | null = null;
  private probeTaskAbort: AbortController | null = null;

  constructor(@Optional() jobId: string = '', @Optional() deps: SerialPortProbeDeps = {}) {
    this.jobId = jobId;
    this.solService = deps.solService ?? null;
    this.dispatchFn = deps.dispatchFn ?? null;
    this.logger = deps.logger ?? null;
    this.sleepFn = deps.sleep ?? DEFAULT_SLEEP;
  }

  private async logWarning(message: string): Promise<void> {
    if (this.logger) await this.logger.warning(message, { jobId: this.jobId });
  }

  private async logInfo(message: string): Promise<void> {
    if (this.logger) await this.logger.info(message, { jobId: this.jobId });
  }

  private async getSolService(): Promise<SolProbeServiceLike> {
    if (this.solService === null) {
      throw new SerialPortProbeError('SOL service not wired into SerialPortProbeService');
    }
    return this.solService;
  }

  private async getDispatch(): Promise<DispatchFn> {
    if (this.dispatchFn === null) {
      throw new SerialPortProbeError('gRPC dispatch not wired into SerialPortProbeService');
    }
    return this.dispatchFn;
  }

  async probe(args: ProbeArgs): Promise<SerialPortProbeResult> {
    const { deviceId, bmcIp, bmcUsername, bmcPassword } = args;
    const bmcPort = args.bmcPort === undefined ? 623 : args.bmcPort;
    const outerGuard = overallGuard(solProbeTimeout(writeTimeout(8)));

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const inner = new AbortController();
    const probeInner = this.probeInner(deviceId, bmcIp, bmcUsername, bmcPassword, bmcPort, inner.signal).catch(
      (err: unknown) => {
        if (err instanceof AbortedError) return null;
        throw err;
      },
    );
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          inner.abort();
          reject(new TimeoutError(`overall probe exceeded ${outerGuard.toFixed(0)}s wall-clock guard`));
        }, outerGuard * 1000);
      });
      const result = await Promise.race([probeInner, timeoutPromise]);
      if (result === null) {
        throw new TimeoutError(`overall probe exceeded ${outerGuard.toFixed(0)}s wall-clock guard`);
      }
      return result;
    } catch (exc) {
      if (exc instanceof TimeoutError) {
        await this.logWarning(`Serial port probe wall-clock timeout for device ${deviceId}`);
        return emptyResult(`overall probe exceeded ${outerGuard.toFixed(0)}s wall-clock guard`);
      }
      const msg = exc instanceof Error ? exc.message : String(exc);
      await this.logWarning(`Serial port probe failed unexpectedly for device ${deviceId}: ${msg}`);
      return emptyResult(`unexpected error: ${msg}`);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      inner.abort();
      // Reap the SOL listener on every exit path — an outer timeout would otherwise leak the IPMI session.
      const task = this.probeTask;
      const abort = this.probeTaskAbort;
      if (task !== null) {
        if (abort !== null) abort.abort();
        try {
          await task;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (this.logger) await this.logger.debug(`SOL listener reap failed: ${msg}`, { jobId: this.jobId });
        }
      }
      this.probeTask = null;
      this.probeTaskAbort = null;
      try {
        await probeInner;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (this.logger) await this.logger.debug(`Serial port probe settle failed: ${msg}`, { jobId: this.jobId });
      }
    }
  }

  private async probeInner(
    deviceId: string,
    bmcIp: string,
    bmcUsername: string,
    bmcPassword: string,
    bmcPort: number,
    signal: AbortSignal,
  ): Promise<SerialPortProbeResult> {
    const dispatch = await this.getDispatch();

    let collection: OperationOutput<'collection.serial_ports'>;
    try {
      collection = await raceAbort(
        dispatch(
          deviceId,
          'collection.serial_ports',
          {},
          {
            jobId: this.jobId,
            timeoutS: AGENT_COLLECT_TIMEOUT_S,
          },
        ),
        signal,
      );
    } catch (exc) {
      if (exc instanceof AbortedError) throw exc;
      const msg = exc instanceof Error ? exc.message : String(exc);
      return emptyResult(`agent collection.serial_ports failed: ${msg}`);
    }
    if (signal.aborted) throw new AbortedError();

    const serialPortsData = collection.serial_ports;
    const detectedPorts = serialPortsData.detected_ports;
    const bmcSolHardware = serialPortsData.bmc_sol_hardware;
    const solBaud = bmcSolHardware.hardware_baud_rate ?? null;

    const candidates = activeCandidates(detectedPorts);
    if (candidates.length === 0) {
      return emptyResult('no active serial ports detected on device', { candidates: [] });
    }

    // sol_capable reflects host KCS access, not BMC LAN SOL — don't short-circuit; the real SOL session is the source of truth.
    const solCapable = bmcSolHardware.sol_capable;
    if (!solCapable) {
      await this.logWarning(
        `Agent reports sol_capable=false for device ${deviceId}; proceeding (host KCS ≠ BMC LAN SOL)`,
      );
    }

    const writeTimeoutS = writeTimeout(candidates.length);
    const solProbeTimeoutS = solProbeTimeout(writeTimeoutS);

    const tokens: Record<string, string> = {};
    for (const name of candidates) {
      tokens[name] = `##BROKKR_PROBE_${name}_${randomUUID().replace(/-/g, '').slice(0, 12)}##`;
    }
    const tokenToPort: Record<string, string> = {};
    for (const [name, tok] of Object.entries(tokens)) {
      tokenToPort[tok] = name;
    }
    const writeBaud = solBaud || 115200;

    const solService = await this.getSolService();
    const abort = new AbortController();
    this.probeTaskAbort = abort;
    this.probeTask = solService.probeForTokens({
      ipAddress: bmcIp,
      username: bmcUsername,
      password: bmcPassword,
      tokens: Object.values(tokens),
      timeout: solProbeTimeoutS,
      port: bmcPort,
      deviceId,
    });
    const probeTask = this.probeTask;

    await raceAbort(this.sleepFn(PROBE_SOL_WARMUP_S * 1000), signal);
    if (signal.aborted) throw new AbortedError();

    // Listener is independent of write dispatch — don't cancel on failure.
    const writePayload = {
      writes: Object.entries(tokens).map(([name, tok]) => ({
        port: name,
        token: tok,
        baud: writeBaud,
      })),
      settle_ms: AGENT_SETTLE_MS,
    };
    let writeResult: Record<string, unknown> | null = null;
    let writeError: string | null = null;
    try {
      const r = await raceAbort(
        dispatch(deviceId, 'diagnostic.write_serial_tokens', writePayload, {
          jobId: this.jobId,
          timeoutS: writeTimeoutS,
        }),
        signal,
      );
      writeResult = isRecord(r) ? r : null;
    } catch (exc) {
      if (exc instanceof AbortedError) throw exc;
      const msg = exc instanceof Error ? exc.message : String(exc);
      writeError = `agent diagnostic.write_serial_tokens failed: ${msg}`;
      await this.logWarning(writeError);
    }
    if (signal.aborted) throw new AbortedError();

    let probeResult: SolProbeResult;
    try {
      probeResult = await raceAbort(probeTask, signal);
    } catch (exc) {
      if (exc instanceof AbortedError) throw exc;
      const msg = exc instanceof Error ? exc.message : String(exc);
      probeResult = {
        matches: [],
        lines_seen: 0,
        duration_seconds: 0.0,
        error: `probe task raised: ${msg}`,
      };
    }
    if (signal.aborted) throw new AbortedError();

    const matches = probeResult.matches ?? [];
    let matchedPort: string | null = null;
    let matchedAt: number | null = null;
    if (matches.length > 0) {
      const first = matches.reduce((best, m) => (pickAtSeconds(m) < pickAtSeconds(best) ? m : best), matches[0]);
      if (typeof first.token === 'string') {
        matchedPort = tokenToPort[first.token] ?? null;
      }
      matchedAt = typeof first.at_seconds === 'number' ? first.at_seconds : null;
    }

    const resolved = buildResolved({
      detectedPorts,
      matchedPort,
      solBaud,
    });
    const agentWrites: unknown = isRecord(writeResult) ? (writeResult['writes'] ?? null) : null;
    const out: SerialPortProbeResult = {
      ...resolved,
      candidates,
      matched_at_seconds: matchedAt,
      agent_writes: agentWrites,
      probe_duration_seconds: typeof probeResult.duration_seconds === 'number' ? probeResult.duration_seconds : null,
    };

    const probeError = typeof probeResult.error === 'string' ? probeResult.error : null;
    if (writeError !== null) out.write_error = writeError;
    if (probeError) out.probe_error = probeError;
    if (matchedPort === null) {
      out.error = writeError || probeError || 'probe completed without matching any token';
    }

    await this.logInfo(
      `Serial port probe complete for ${deviceId}: port=${out.port ?? 'null'} confirmed=${out.confirmed} candidates=${JSON.stringify(candidates)}` +
        (writeError ? ` write_error=${writeError}` : ''),
    );

    return out;
  }
}

export async function createSerialPortProbeService(
  jobId: string = '',
  deps: SerialPortProbeDeps = {},
): Promise<SerialPortProbeService> {
  return new SerialPortProbeService(jobId, deps);
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

class AbortedError extends Error {
  constructor() {
    super('inner probe aborted by outer guard');
    this.name = 'AbortedError';
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(new AbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}

function pickAtSeconds(value: SolProbeMatch): number {
  return typeof value.at_seconds === 'number' ? value.at_seconds : Number.POSITIVE_INFINITY;
}
