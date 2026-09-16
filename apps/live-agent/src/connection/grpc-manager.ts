import { readFile } from 'node:fs/promises';

import type { AgentConfig } from '../config';
import { getErrorMessage } from '../errors';
import { makeLogger } from '../logger';
import type { TraceSender } from '../telemetry/relay-exporter';
import { Backoff } from './backoff';
import { deriveGrpcAddress } from './grpc-address';
import { mergeHostsEntries, parseHostsFileContent, writeBridgeHostsBlock, type HostsEntry } from './hosts-file';
import { LogShipper } from './log-shipper';
import { createSiblingTransportPool, createTransportPool, type AgentServiceClient, type TransportPool } from './pool';
import { createResultReporter, type ResultReporter } from './result-reporter';
import { runSession } from './session';
import { sleepWithAbort } from './sleep';
import { TokenRenewer } from './token-renewer';
import { createTraceSender } from './trace-shipper';
const logger = makeLogger('grpc-manager');

// eslint-disable-next-line turbo/no-undeclared-env-vars
const HOSTS_FILE_PATH = process.env.BROKKR_HOSTS_FILE ?? '/etc/hosts';

let hostsRefreshQueue = Promise.resolve();

// /etc/hosts is a fallback channel; unprivileged-agent EPERM must not tear down the topology callback.
export function refreshHostsFile(
  hostsEntries: ReadonlyArray<HostsEntry>,
  hostsPath: string = HOSTS_FILE_PATH,
): Promise<void> {
  if (hostsEntries.length === 0) {
    return Promise.resolve();
  }

  const refresh = hostsRefreshQueue.then(async () => {
    try {
      const original = await readFile(hostsPath, 'utf8');
      const existing = parseHostsFileContent(original)?.entries ?? [];
      await writeBridgeHostsBlock(hostsPath, original, mergeHostsEntries(existing, hostsEntries));
    } catch (err) {
      logger.warn('failed to refresh /etc/hosts on topology update', {
        hosts_path: hostsPath,
        err: getErrorMessage(err),
      });
    }
  });
  hostsRefreshQueue = refresh.catch(() => undefined);
  return refresh;
}

interface SessionTask {
  abort: AbortController;
}

export class GrpcConnectionManager {
  private readonly pool: TransportPool;
  // Log/trace shipping only -- see createSiblingTransportPool.
  private readonly telemetryPool: TransportPool;
  private readonly reporter: ResultReporter;
  private readonly sessions = new Map<string, SessionTask>();
  private readonly permanentlyRejected = new Set<string>();
  private readonly logShipper: LogShipper;
  private readonly tokenRenewer: TokenRenewer;
  private stopped = false;
  private phoneHomeCursor = 0;
  private readonly globalAbort = new AbortController();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  readonly traceSender: TraceSender;

  constructor(private readonly config: AgentConfig) {
    this.pool = createTransportPool(config);
    this.telemetryPool = createSiblingTransportPool(this.pool, config);
    // Result reporting stays on the session pool: it is request/response, low
    // volume, and not amplified by session failure the way log shipping is.
    this.reporter = createResultReporter(this.pool);
    this.logShipper = new LogShipper({
      deviceId: config.device_id,
      pool: this.telemetryPool,
    });
    this.tokenRenewer = new TokenRenewer({
      deviceId: config.device_id,
      pool: this.pool,
      intervalMs: config.agent.token_renew_interval_ms,
    });
    this.traceSender = createTraceSender({ deviceId: config.device_id, pool: this.telemetryPool });
  }

  start(): void {
    if (this.stopped) {
      throw new Error('GrpcConnectionManager is single-shot; construct a new instance after stop()');
    }
    this.logShipper.start();
    this.tokenRenewer.start();
    this.keepAliveTimer = setInterval(() => {}, 60_000);
    const initial = this.config.bridges.map((b) =>
      deriveGrpcAddress(b.address, { insecure: this.config.insecure, override: b.grpc_address }),
    );
    this.reconcile(initial);
  }

  private deriveBridgeUrl(address: string): string {
    const override = this.config.bridges.find((b) => b.address === address)?.grpc_address;
    return deriveGrpcAddress(address, { insecure: this.config.insecure, override });
  }

  stop(): void {
    this.stopped = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.logShipper.stop();
    this.tokenRenewer.stop();
    this.globalAbort.abort();
    for (const [addr, task] of this.sessions.entries()) {
      logger.info('stopping gRPC session', { address: addr });
      task.abort.abort();
    }
    this.sessions.clear();
  }

  private reconcile(addresses: readonly string[]): void {
    const desired = new Set(addresses);

    for (const [addr, task] of this.sessions.entries()) {
      if (!desired.has(addr)) {
        logger.info('removing gRPC session (topology)', { address: addr });
        task.abort.abort();
        this.sessions.delete(addr);
        this.pool.removeBridge(addr);
        this.telemetryPool.removeBridge(addr);
      }
    }

    for (const addr of desired) {
      if (this.permanentlyRejected.has(addr)) {
        logger.debug('skipping permanently rejected bridge', { address: addr });
        continue;
      }
      if (!this.sessions.has(addr)) {
        logger.info('adding gRPC session', { address: addr });
        this.startSessionLoop(addr);
      }
    }
  }

  private startSessionLoop(bridgeAddr: string): void {
    const abort = new AbortController();
    this.sessions.set(bridgeAddr, { abort });

    const onGlobal = () => abort.abort();
    this.globalAbort.signal.addEventListener('abort', onGlobal, { once: true });

    const backoff = new Backoff({
      initial_ms: this.config.agent.reconnect_backoff_initial_ms,
      max_ms: this.config.agent.reconnect_backoff_max_ms,
      min_ms: this.config.agent.reconnect_backoff_initial_ms,
    });

    const loop = async () => {
      while (!abort.signal.aborted && !this.stopped) {
        let registeredAtMs: number | null = null;
        try {
          const client = this.pool.getClient(bridgeAddr);

          const result = await runSession(
            client,
            bridgeAddr,
            this.config,
            this.reporter,
            {
              onRegistered: (bridges) => {
                registeredAtMs = Date.now();
                // Empty = bridge Redis sick; skip to avoid reconnect storm.
                if (bridges.length > 0) {
                  this.reconcile(bridges.map((b) => this.deriveBridgeUrl(b.address)));
                }
              },
              onTopologyUpdate: (bridges, hostsEntries) => {
                void refreshHostsFile(hostsEntries);
                if (bridges.length > 0) {
                  this.reconcile(bridges.map((b) => this.deriveBridgeUrl(b.address)));
                }
              },
            },
            abort.signal,
            () => this.livePhoneHomeClient(),
          );

          if (result.permanent) {
            logger.warn('gRPC session permanently rejected, evicting', {
              address: bridgeAddr,
            });
            this.permanentlyRejected.add(bridgeAddr);
            this.sessions.delete(bridgeAddr);
            this.pool.removeBridge(bridgeAddr);
            this.telemetryPool.removeBridge(bridgeAddr);
            break;
          }

          if (abort.signal.aborted || this.stopped) break;

          // Reset backoff only after a sustained-healthy session — an accept-then-drop bridge would otherwise zero the attempt counter every cycle and reconnect-storm.
          if (registeredAtMs !== null && Date.now() - registeredAtMs >= this.config.agent.heartbeat_interval_ms) {
            backoff.reset();
          }

          const delay = backoff.next();
          logger.info('gRPC reconnecting after backoff', {
            address: bridgeAddr,
            delay_ms: delay,
          });

          await sleepWithAbort(delay, abort.signal);
        } catch (err) {
          logger.error('session loop iteration threw, retrying after max backoff', {
            address: bridgeAddr,
            err: getErrorMessage(err),
          });
          await sleepWithAbort(this.config.agent.reconnect_backoff_max_ms, abort.signal);
        }
      }

      this.globalAbort.signal.removeEventListener('abort', onGlobal);
    };

    void loop().catch((err: unknown) => {
      logger.error('session loop crashed; clearing bridge', {
        address: bridgeAddr,
        err: getErrorMessage(err),
      });
      abort.abort();
      this.sessions.delete(bridgeAddr);
    });
  }

  // Round-robin, not pinned to index 0 — pinning would exhaust the phone-home retry ladder against one stale bridge.
  private livePhoneHomeClient(): AgentServiceClient | null {
    const sessionAddrs = [...this.sessions.keys()];
    const source = sessionAddrs.length > 0 ? sessionAddrs : this.pool.listAddresses();
    const candidates = source.filter((addr) => !this.permanentlyRejected.has(addr));
    if (candidates.length === 0) return null;
    const addr = candidates[this.phoneHomeCursor % candidates.length]!;
    this.phoneHomeCursor++;
    return this.pool.getClient(addr);
  }
}
