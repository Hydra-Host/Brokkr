import type { Client } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import { getErrorMessage } from '../errors';
import type { AgentService } from '../gen/brokkr/agent/v1/agent_pb';
import type { PartialResult, WorkProgress, WorkResponse } from '../gen/brokkr/agent/v1/work_pb';
import { makeLogger } from '../logger';
import { Backoff } from './backoff';
import type { TransportPool } from './pool';
const logger = makeLogger('result-reporter');

type AgentServiceClient = Client<typeof AgentService>;

export interface ReportOptions {
  preferredBridge?: string;
  retryInitialMs?: number;
  retryMaxMs?: number;
}

export interface ResultReporter {
  reportResult(response: WorkResponse, opts?: ReportOptions): Promise<void>;
  reportProgress(progress: WorkProgress, opts?: ReportOptions): Promise<void>;
  reportPartialResult(partial: PartialResult, opts?: ReportOptions): Promise<void>;
}

const MAX_RETRIES_PER_BRIDGE = 8;
const RETRY_INITIAL_MS = 200;
const RETRY_MAX_MS = 5000;

const RETRYABLE_GRPC_CODES: ReadonlySet<Code> = new Set([
  Code.Unavailable,
  Code.Internal,
  Code.ResourceExhausted,
  Code.Aborted,
  Code.DeadlineExceeded,
]);

function isRetryable(err: unknown): boolean {
  const msg = getErrorMessage(err);
  if (/NGHTTP2_REFUSED_STREAM|REFUSED_STREAM|ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(msg)) {
    return true;
  }
  if (err instanceof ConnectError) {
    return RETRYABLE_GRPC_CODES.has(err.code);
  }
  return /UNAVAILABLE/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === 'object' && 'unref' in t) t.unref();
  });
}

async function attemptWithRetry(
  fn: () => Promise<void>,
  onRetry: (err: unknown, delayMs: number, attempt: number) => void,
  backoffCfg: { initial_ms: number; max_ms: number } = { initial_ms: RETRY_INITIAL_MS, max_ms: RETRY_MAX_MS },
): Promise<void> {
  const backoff = new Backoff(backoffCfg);
  let attempt = 0;
  while (true) {
    try {
      await fn();
      return;
    } catch (error) {
      if (attempt >= MAX_RETRIES_PER_BRIDGE || !isRetryable(error)) {
        throw error;
      }
      attempt += 1;
      const delayMs = backoff.next();
      onRetry(error, delayMs, attempt);
      await sleep(delayMs);
    }
  }
}

async function tryWithFallback(
  pool: TransportPool,
  rpcName: string,
  opts: ReportOptions,
  fn: (client: AgentServiceClient) => Promise<void>,
): Promise<void> {
  const preferredBridge = opts.preferredBridge;
  const backoffCfg = {
    initial_ms: opts.retryInitialMs ?? RETRY_INITIAL_MS,
    max_ms: opts.retryMaxMs ?? RETRY_MAX_MS,
  };
  const addresses = pool.listAddresses();

  const ordered: string[] = [];
  if (preferredBridge && addresses.includes(preferredBridge)) {
    ordered.push(preferredBridge);
  }
  for (const addr of addresses) {
    if (addr !== preferredBridge) {
      ordered.push(addr);
    }
  }

  if (ordered.length === 0) {
    throw new Error(`${rpcName}: no bridges available in pool`);
  }

  let lastError: unknown;
  for (const addr of ordered) {
    try {
      await attemptWithRetry(
        async () => {
          const client = pool.getClient(addr);
          await fn(client);
        },
        (err, delayMs, attempt) => {
          logger.warn(`${rpcName} retrying after transient error`, {
            address: addr,
            attempt,
            delay_ms: delayMs,
            err: getErrorMessage(err),
          });
        },
        backoffCfg,
      );
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`${rpcName} failed on bridge, trying next`, {
        address: addr,
        err: getErrorMessage(error),
      });
    }
  }

  // Failover is safe: results are idempotent by work_id (Redis SET overwrites, duplicate PUBLISH is a no-op).
  throw new Error(`${rpcName}: all ${ordered.length} bridges failed; last error: ${getErrorMessage(lastError)}`);
}

export function createResultReporter(pool: TransportPool): ResultReporter {
  return {
    async reportResult(response: WorkResponse, opts: ReportOptions = {}): Promise<void> {
      await tryWithFallback(pool, 'reportResult', opts, async (client) => {
        await client.reportResult(response);
      });
    },

    async reportProgress(progress: WorkProgress, opts: ReportOptions = {}): Promise<void> {
      try {
        await tryWithFallback(pool, 'reportProgress', opts, async (client) => {
          await client.reportProgress(progress);
        });
      } catch (error) {
        logger.warn('reportProgress: all bridges failed, dropping progress', {
          work_id: progress.workId,
          err: getErrorMessage(error),
        });
      }
    },

    async reportPartialResult(partial: PartialResult, opts: ReportOptions = {}): Promise<void> {
      await tryWithFallback(pool, 'reportPartialResult', opts, async (client) => {
        await client.reportPartialResult(partial);
      });
    },
  };
}
