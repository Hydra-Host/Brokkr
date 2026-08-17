import { Injectable } from '@nestjs/common';
import { getTelemetryMeter } from '@repo/telemetry';
import { getErrorMessage } from '../common/error-utils';
import { getActiveBridgePlugins } from '../plugin-host/active-plugins-holder';
import { emitBridgePluginEvent } from '../plugin-host/bridge-plugin-event-holder';

import { createRunExclusive } from '../common/async/run-exclusive';
import { ContextLogger } from '../logger/logger.service';

import { getLeaderConfig, type LeaderConfig } from './leader-election.config';

export interface InterfaceEntry {
  iface: string;
  mac: string;
  subnet: string;
  ip: string;
  gateway?: string;
  // True for L3-routed destinations: `gateway` is the next-hop to REACH `subnet`,
  // not a default gateway FOR hosts on it — never derive prefix gateways from these.
  routed?: boolean;
}

export interface LeaderCache {
  setNx(key: string, value: string, opts: { ttlSeconds: number }): Promise<boolean>;
  renewIfOwner(key: string, expectedValue: string, opts: { ttlSeconds: number }): Promise<boolean>;
  deleteIfOwner(key: string, expectedValue: string): Promise<boolean>;
  get(key: string): Promise<string | null>;
  hset(key: string, mapping: Record<string, string>, opts: { ttlSeconds: number }): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  delete(key: string): Promise<number>;
  scan(pattern: string): Promise<string[]>;
}

export interface InterfaceEnumerator {
  enumerate(): Promise<InterfaceEntry[]>;
}

export interface VersionInfo {
  brokkrWorkerVersion: string;
  brokkrLiveVersion: string;
}

function floatString(seconds: number): string {
  if (Number.isInteger(seconds)) return `${seconds}.0`;
  return String(seconds);
}

@Injectable()
export class LeaderElectionService {
  readonly config: LeaderConfig;

  private readonly meter = getTelemetryMeter('brokkr-bridge');
  private readonly leaderTransitions = this.meter.createCounter('brokkr.leader.transitions', {
    description: 'Leadership role transitions on this bridge, by resulting role',
  });

  private isLeaderFlag = false;
  private leaderSince: number | null = null;
  private lastKnownLeader: string | null = null;
  private stopped = false;
  private runExclusive = createRunExclusive();
  private initialTickOk: boolean | null = null;
  private lastInitialTickError: string | null = null;

  constructor(
    private readonly cache: LeaderCache,
    private readonly interfaces: InterfaceEnumerator,
    private readonly versionInfo: () => VersionInfo,
    private readonly logger: ContextLogger,
    config?: LeaderConfig,
    private readonly jobId: string = '',
  ) {
    this.config = config ?? getLeaderConfig();
    this.meter
      .createObservableGauge('brokkr.leader.is_leader', {
        description: 'Whether this bridge currently holds zone leadership (1) or not (0)',
      })
      .addCallback((result) => result.observe(this.isLeaderFlag ? 1 : 0));
  }

  get isLeader(): boolean {
    return this.isLeaderFlag;
  }

  // Single seam for a real leadership transition: the metric and the plugin
  // event must always fire together, at the same spots.
  private noteLeadershipChanged(isLeader: boolean): void {
    this.leaderTransitions.add(1, { to: isLeader ? 'leader' : 'follower' });
    emitBridgePluginEvent('bridge.leadership.changed', { instanceId: this.config.instanceId, isLeader });
  }

  get instanceId(): string {
    return this.config.instanceId;
  }

  get leaderSinceTimestamp(): number | null {
    return this.leaderSince;
  }

  async start(): Promise<void> {
    void this.logger.info(
      `Starting leader election for instance ${this.config.instanceId} ` +
        `(ttl=${this.config.leaderTtlSeconds}s, renew=${this.config.leaderRenewIntervalSeconds}s)`,
    );
    try {
      await this.heartbeat();
      this.initialTickOk = true;
      this.lastInitialTickError = null;
    } catch (error) {
      // Python parity: intentional swallow — a Redis-down boot must not crash the bridge; the failure is surfaced via getLeaderInfo and the cron recovers later.
      this.initialTickOk = false;
      this.lastInitialTickError = getErrorMessage(error);
      void this.logger.warning(`Initial leader heartbeat failed: ${getErrorMessage(error)}`);
    }
  }

  async heartbeat(signal?: AbortSignal): Promise<void> {
    await this.runExclusive(async () => {
      if (this.stopped) return;
      try {
        await this.electionTick(signal);
        await this.registerInstance(signal);
      } catch (error) {
        if (this.isLeaderFlag) {
          this.isLeaderFlag = false;
          this.leaderSince = null;
          this.noteLeadershipChanged(false);
        }
        throw error;
      }
    });
  }

  async tryClaimLeadershipIfVacant(): Promise<boolean> {
    return this.runExclusive(async () => {
      if (this.stopped || this.isLeaderFlag) return false;
      const claimed = await this.cache.setNx(this.config.leaderKey, this.config.instanceId, {
        ttlSeconds: this.config.leaderTtlSeconds,
      });
      if (!claimed) return false;
      this.isLeaderFlag = true;
      this.leaderSince = Date.now() / 1000;
      try {
        await this.registerInstance();
      } catch (error) {
        void this.logger.warning(`Vacant-claim registry update failed: ${getErrorMessage(error)}`);
      }
      void this.logger.info(`Instance ${this.config.instanceId} claimed vacant leadership (opportunistic)`);
      this.noteLeadershipChanged(true);
      return true;
    });
  }

  markHeartbeatTimedOut(): void {
    if (this.isLeaderFlag) {
      this.isLeaderFlag = false;
      this.leaderSince = null;
      this.noteLeadershipChanged(false);
    }
    this.runExclusive = createRunExclusive();
  }

  async stop(): Promise<void> {
    await this.runExclusive(async () => {
      this.stopped = true;
      try {
        await this.releaseLeadership();
      } catch (error) {
        void this.logger.warning(`Error releasing leadership during shutdown: ${getErrorMessage(error)}`);
      }
      try {
        await this.deregisterInstance();
      } catch (error) {
        void this.logger.warning(`Error deregistering instance during shutdown: ${getErrorMessage(error)}`);
      }
    });
  }

  async getRegisteredInstances(): Promise<Record<string, string>[]> {
    const pattern = `${this.config.registryKeyPrefix}*`;
    const keys = await this.cache.scan(pattern);
    const instances: Record<string, string>[] = [];
    for (const key of keys) {
      const data = await this.cache.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        instances.push(data);
      }
    }
    return instances;
  }

  async getLeaderInfo(): Promise<{
    instance_id: string;
    is_leader: boolean;
    current_leader: string | null;
    leader_since: number | null;
    registered_instances: Record<string, string>[];
    leader_ttl_seconds: number;
    renew_interval_seconds: number;
    initial_tick_ok: boolean | null;
    last_initial_tick_error: string | null;
  }> {
    const currentLeader = await this.cache.get(this.config.leaderKey);
    const instances = await this.getRegisteredInstances();
    return {
      instance_id: this.config.instanceId,
      is_leader: this.isLeaderFlag,
      current_leader: currentLeader,
      leader_since: this.leaderSince,
      registered_instances: instances,
      leader_ttl_seconds: this.config.leaderTtlSeconds,
      renew_interval_seconds: this.config.leaderRenewIntervalSeconds,
      initial_tick_ok: this.initialTickOk,
      last_initial_tick_error: this.lastInitialTickError,
    };
  }

  private async electionTick(signal?: AbortSignal): Promise<void> {
    if (this.isLeaderFlag) {
      const renewed = await this.cache.renewIfOwner(this.config.leaderKey, this.config.instanceId, {
        ttlSeconds: this.config.leaderTtlSeconds,
      });
      throwIfAborted(signal);
      if (!renewed) {
        const duration = this.leaderSince !== null ? Date.now() / 1000 - this.leaderSince : 0;
        this.isLeaderFlag = false;
        this.leaderSince = null;
        void this.logger.warning(`Lost leadership after ${duration.toFixed(0)}s`);
        this.noteLeadershipChanged(false);
      }
      return;
    }

    const claimed = await this.cache.setNx(this.config.leaderKey, this.config.instanceId, {
      ttlSeconds: this.config.leaderTtlSeconds,
    });
    throwIfAborted(signal);
    if (claimed) {
      this.isLeaderFlag = true;
      this.leaderSince = Date.now() / 1000;
      void this.logger.info(`Instance ${this.config.instanceId} elected as leader`);
      this.noteLeadershipChanged(true);
      return;
    }

    const currentLeader = await this.cache.get(this.config.leaderKey);
    throwIfAborted(signal);
    if (currentLeader === this.config.instanceId) {
      this.isLeaderFlag = true;
      if (this.leaderSince === null) this.leaderSince = Date.now() / 1000;
      void this.logger.info(`Instance ${this.config.instanceId} re-derived leadership from owned key`);
      this.noteLeadershipChanged(true);
      return;
    }
    if (currentLeader && currentLeader !== this.lastKnownLeader) {
      this.lastKnownLeader = currentLeader;
      void this.logger.debug(`Current leader is: ${currentLeader}`);
    }
  }

  private async releaseLeadership(): Promise<void> {
    // we are stopping regardless, so drop local leadership even if the Redis delete
    // fails (Redis unreachable on shutdown) — the key self-expires via its TTL.
    const wasLeader = this.isLeaderFlag;
    try {
      const deleted = await this.cache.deleteIfOwner(this.config.leaderKey, this.config.instanceId);
      if (deleted) {
        void this.logger.info(`Released leadership for instance ${this.config.instanceId}`);
      } else {
        void this.logger.debug(`No leader key to release for instance ${this.config.instanceId}`);
      }
    } finally {
      this.isLeaderFlag = false;
      this.leaderSince = null;
      // A shutdown release is a real transition but deliberately emits no plugin event.
      if (wasLeader) this.leaderTransitions.add(1, { to: 'follower' });
    }
  }

  private async registerInstance(signal?: AbortSignal): Promise<void> {
    const key = `${this.config.registryKeyPrefix}${this.config.instanceId}`;
    const interfaces = await this.safeEnumerate();
    throwIfAborted(signal);
    const versions = this.versionInfo();
    const mapping: Record<string, string> = {
      instance_id: this.config.instanceId,
      is_leader: this.isLeaderFlag ? 'True' : 'False',
      brokkr_worker_version: versions.brokkrWorkerVersion,
      brokkr_live_version: versions.brokkrLiveVersion,
      registered_at: floatString(Date.now() / 1000),
      interfaces_json: JSON.stringify(interfaces),
      active_plugins_json: JSON.stringify(getActiveBridgePlugins()),
    };
    await this.cache.hset(key, mapping, { ttlSeconds: this.config.registryTtlSeconds });
    throwIfAborted(signal);
  }

  private async deregisterInstance(): Promise<void> {
    const key = `${this.config.registryKeyPrefix}${this.config.instanceId}`;
    await this.cache.delete(key);
    void this.logger.info(`Deregistered instance ${this.config.instanceId} from service registry`);
  }

  private async safeEnumerate(): Promise<InterfaceEntry[]> {
    try {
      return await this.interfaces.enumerate();
    } catch (error) {
      void this.logger.warning(`Failed to enumerate local interfaces for registry: ${getErrorMessage(error)}`);
      return [];
    }
  }
}

class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError('aborted');
}

let leaderService: LeaderElectionService | null = null;

export function getLeaderService(): LeaderElectionService | null {
  return leaderService;
}

export function setLeaderService(service: LeaderElectionService | null): void {
  leaderService = service;
}
