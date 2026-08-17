import { Injectable } from '@nestjs/common';

import { getTelemetryMeter } from '@repo/telemetry';
import { isRecord } from '@repo/utils';

import { createRunExclusive } from '../common/async/run-exclusive';
import { getErrorMessage, hasErrnoCode } from '../common/error-utils';
import { CommandFailed, run, type CommandResult } from '../common/process/run-command';
import { vrrpConfigScanPattern } from '../common/redis/redis-keys';
import { RedisService } from '../common/redis/redis.service';
import { readAtom } from '../device-record/atom/atom-fetcher';
import { ContextLogger } from '../logger/logger.service';

import { VrrpValueSchema } from './vrrp-value.schema';

const DEFAULT_GARP_COUNT = 5;
const ADD_DEL_TIMEOUT_SECONDS = 5;
const SHOW_TIMEOUT_SECONDS = 5;
const GARP_TIMEOUT_BUFFER_SECONDS = 2;
// Release paths are stateless (can only act on what `ip -j addr show` returns), so transient read failures must be retried, not conceded.
const RELEASE_READ_ATTEMPTS = 3;

const VRRP_LABEL = 'brokkr-vrrp';

export type LeaderStatusProvider = () => boolean;

export type RunCommand = (cmd: readonly string[], timeoutSeconds?: number) => Promise<CommandResult>;

interface DesiredBinding {
  iface: string;
  garpCount: number;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false };

// A missing `ip` binary can never mean an orphaned VIP (nothing could have been bound with it), so ENOENT must not raise the duplicate-IP alarm.
function isBinaryMissing(error: unknown): boolean {
  return hasErrnoCode(error) && error.code === 'ENOENT';
}

function hostOf(cidr: string): string {
  const slash = cidr.indexOf('/');
  return slash === -1 ? cidr : cidr.slice(0, slash);
}

function isIdempotentAddSuccess(error: unknown): boolean {
  return error instanceof CommandFailed && /file exists/i.test(error.stderr);
}

function isIdempotentDelSuccess(error: unknown): boolean {
  return error instanceof CommandFailed && /cannot assign requested address/i.test(error.stderr);
}

/** Fail-closed: any SCAN/`ip` read failure aborts the tick and keeps current bindings; `stopped` + the lifecycle lock order detachAll() before any late reconcileOnce() so a just-released VIP can't re-bind (duplicate-IP window). */
@Injectable()
export class VrrpReconcilerService {
  private stopped = false;
  private readonly runExclusive = createRunExclusive();
  private lastReadWasBinaryMissing = false;
  private warnedUnnamedWhileLeader = false;
  private warnedAssignedWithoutIpTool = false;

  private readonly meter = getTelemetryMeter('brokkr-bridge');
  private readonly vipEvents = this.meter.createCounter('brokkr.vrrp.vip_events', {
    description: 'VRRP VIP address operations applied via ip addr on this host, by action',
  });
  private readonly reconcileAborts = this.meter.createCounter('brokkr.vrrp.reconcile_aborts', {
    description: 'VRRP reconcile ticks aborted on a failed read, deliberately preserving current bindings',
  });
  // Converged count of VIPs actually held — driven by each ensure/release outcome, not the desired set,
  // so a skipped bind or failed release is reflected. Stored, not shelled out per metrics collection.
  private boundVipCount = 0;

  constructor(
    private readonly isLeader: LeaderStatusProvider,
    private readonly redis: RedisService,
    private readonly logger: ContextLogger,
    private readonly jobId: string = '',
    private readonly selfInstanceId: string = '',
    private readonly runCommand: RunCommand = run,
  ) {
    this.meter
      .createObservableGauge('brokkr.vrrp.bound_vips', {
        description: 'VRRP VIPs this bridge currently holds (brokkr-vrrp labeled addresses)',
      })
      .addCallback((result) => result.observe(this.boundVipCount));
  }

  async reconcileOnce(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.stopped) return;

      const actualRead = await this.readActualBindings();
      if (!actualRead.ok) {
        await this.warnIfAssignedWithoutIpTool();
        this.reconcileAborts.add(1, { reason: 'read_bindings' });
        return;
      }
      this.warnedAssignedWithoutIpTool = false;
      const actual = actualRead.value;
      this.boundVipCount = actual.size;

      const releaseAllActual = async (): Promise<void> => {
        let held = 0;
        for (const [vip, iface] of actual) {
          if (!(await this.releaseVip(vip, iface))) held += 1;
        }
        this.boundVipCount = held;
      };

      if (!this.isLeader()) {
        await releaseAllActual();
        return;
      }

      const desiredRead = await this.computeDesired();
      if (!desiredRead.ok) {
        this.reconcileAborts.add(1, { reason: 'compute_desired' });
        return;
      }
      // Leadership can drop during computeDesired's Redis I/O; binding on a stale "leader" read would
      // duplicate the new leader's VIPs, so re-check and release — the dup-IP window stays TTL-bounded.
      if (!this.isLeader()) {
        await releaseAllActual();
        return;
      }
      const desired = desiredRead.value;

      // Count what we actually converged to, not what we intended: a bind ensureVip skipped
      // (foreign address) or failed, or a release that failed, must be reflected in the gauge.
      let held = 0;
      for (const [vip, binding] of desired) {
        if (await this.ensureVip(vip, binding, actual)) held += 1;
      }
      for (const [vip, actualIface] of actual) {
        const desiredIface = desired.get(vip)?.iface;
        if (desiredIface !== actualIface) {
          const released = await this.releaseVip(vip, actualIface);
          // A release we couldn't apply leaves the VIP bound on actualIface — count it as held, unless
          // it's already a desired bind on another iface (readActualBindings keys by VIP, so they collapse).
          if (!released && !desired.has(vip)) held += 1;
        }
      }
      this.boundVipCount = held;
    });
  }

  // Boot/broken-host diagnostic: `ip` is missing but the hub has assigned this bridge VIP(s) —
  // without it the atoms can never be honored. Latched until a read succeeds.
  private async warnIfAssignedWithoutIpTool(): Promise<void> {
    if (!this.lastReadWasBinaryMissing || this.warnedAssignedWithoutIpTool || !this.isLeader()) return;
    const desiredRead = await this.computeDesired();
    if (!desiredRead.ok || desiredRead.value.size === 0) return;
    this.warnedAssignedWithoutIpTool = true;
    void this.logger.error(
      `The hub has assigned this bridge VIP(s) [${[...desiredRead.value.keys()].join(', ')}] but ` +
        '`ip` is not installed on this host — they cannot be bound here until the tool is installed.',
      { jobId: this.jobId },
    );
  }

  /** Shutdown hook: unconditionally release every VIP this daemon holds, before the leader key is released. */
  async detachAll(): Promise<void> {
    await this.runExclusive(async () => {
      this.stopped = true;
      await this.releaseAllBound();
    });
  }

  private async releaseAllBound(): Promise<void> {
    // Release must retry a read blip: detach sets `stopped` so no later tick retries, and conceding leaves VIPs bound while leadership moves on.
    let read = await this.readActualBindings();
    let binaryMissing = this.lastReadWasBinaryMissing;
    for (let attempt = 1; !read.ok && !binaryMissing && attempt < RELEASE_READ_ATTEMPTS; attempt += 1) {
      read = await this.readActualBindings();
      binaryMissing = this.lastReadWasBinaryMissing;
    }
    if (!read.ok) {
      if (binaryMissing) {
        void this.logger.debug(
          '`ip` is not installed on this host — nothing could have been bound, so nothing to release.',
          { jobId: this.jobId },
        );
      } else {
        void this.logger.error(
          `Could not read interface state to release VRRP VIPs after ${RELEASE_READ_ATTEMPTS} attempts — ` +
            'any bound VIPs may remain (duplicate-IP risk on failover until cleared)',
          { jobId: this.jobId },
        );
      }
      return;
    }
    let held = 0;
    for (const [vip, iface] of read.value) {
      if (!(await this.releaseVip(vip, iface))) held += 1;
    }
    this.boundVipCount = held;
  }

  private async computeDesired(): Promise<ReadResult<Map<string, DesiredBinding>>> {
    const desired = new Map<string, DesiredBinding>();
    let keys: string[];
    try {
      keys = await this.redis.scan(vrrpConfigScanPattern(), this.jobId);
    } catch (error) {
      void this.logger.warning(
        `Failed to SCAN VRRP VIP atoms — aborting tick to preserve current bindings: ${getErrorMessage(error)}`,
        { jobId: this.jobId },
      );
      return { ok: false };
    }
    let namedInAnyAtom = false;
    try {
      const values = await Promise.all(
        keys.map((key) => readAtom(this.redis, key, VrrpValueSchema, { jobId: this.jobId })),
      );
      for (const value of values) {
        if (value === null) continue;
        const iface = value.ifaceByBridge[this.selfInstanceId];
        if (iface === undefined) {
          void this.logger.debug(
            `VRRP atom for ${value.vip} does not name this bridge (${this.selfInstanceId}); not binding. Named: [${Object.keys(value.ifaceByBridge).join(', ')}]`,
            { jobId: this.jobId },
          );
          continue;
        }
        namedInAnyAtom = true;
        desired.set(value.vip, { iface, garpCount: value.garpCount ?? DEFAULT_GARP_COUNT });
      }
    } catch (error) {
      void this.logger.warning(
        `Failed to read VRRP VIP atoms — aborting tick to preserve current bindings: ${getErrorMessage(error)}`,
        { jobId: this.jobId },
      );
      return { ok: false };
    }
    if (keys.length > 0 && !namedInAnyAtom) {
      if (!this.warnedUnnamedWhileLeader) {
        this.warnedUnnamedWhileLeader = true;
        void this.logger.warning(
          `Leader is named in none of ${keys.length} published VRRP atom(s); no VIP will be bound here. ` +
            `Check that this bridge's BRIDGE_HOSTNAME (${this.selfInstanceId}) matches its hub binding.`,
          { jobId: this.jobId },
        );
      }
    } else {
      this.warnedUnnamedWhileLeader = false;
    }
    return { ok: true, value: desired };
  }

  /** Bind `vip` per `binding` if not already there. Returns true when the VIP ends up held by us. */
  private async ensureVip(vip: string, binding: DesiredBinding, actual: Map<string, string>): Promise<boolean> {
    const { iface, garpCount } = binding;
    if (actual.get(vip) === iface) return true; // already correctly bound — true no-op, no GARP
    try {
      await this.runCommand(['ip', 'addr', 'add', vip, 'dev', iface, 'label', VRRP_LABEL], ADD_DEL_TIMEOUT_SECONDS);
    } catch (error) {
      if (!isIdempotentAddSuccess(error)) {
        void this.logger.error(`Failed to bind VRRP VIP ${vip} on ${iface}: ${getErrorMessage(error)}`, {
          jobId: this.jobId,
        });
        return false;
      }
      if (!actual.has(vip)) {
        void this.logger.error(
          `VRRP VIP ${vip} already exists on this host without the ${VRRP_LABEL} label (foreign or manually ` +
            `added); refusing to claim it — it cannot be managed or released here. Remove the conflicting address.`,
          { jobId: this.jobId },
        );
        return false;
      }
    }
    this.vipEvents.add(1, { action: 'bind' });
    void this.logger.info(`Bound VRRP VIP ${vip} on ${iface}`, { jobId: this.jobId });
    await this.sendGarp(vip, iface, garpCount);
    return true;
  }

  /** Release `vip` from `iface`. Returns true when the VIP is no longer bound (released or absent). */
  private async releaseVip(vip: string, iface: string): Promise<boolean> {
    try {
      await this.runCommand(['ip', 'addr', 'del', vip, 'dev', iface], ADD_DEL_TIMEOUT_SECONDS);
      this.vipEvents.add(1, { action: 'release' });
      void this.logger.info(`Released VRRP VIP ${vip} on ${iface}`, { jobId: this.jobId });
      return true;
    } catch (error) {
      // "Cannot assign requested address" means it was already gone — treat as released.
      if (isIdempotentDelSuccess(error)) return true;
      void this.logger.error(`Failed to release VRRP VIP ${vip} on ${iface}: ${getErrorMessage(error)}`, {
        jobId: this.jobId,
      });
      return false;
    }
  }

  private async sendGarp(vip: string, iface: string, garpCount: number): Promise<void> {
    try {
      await this.runCommand(
        ['arping', '-U', '-c', String(garpCount), '-I', iface, hostOf(vip)],
        garpCount + GARP_TIMEOUT_BUFFER_SECONDS,
      );
    } catch (error) {
      void this.logger.warning(`GARP failed for ${vip} on ${iface}: ${getErrorMessage(error)}`, { jobId: this.jobId });
    }
  }

  private async readActualBindings(): Promise<ReadResult<Map<string, string>>> {
    this.lastReadWasBinaryMissing = false;
    const actual = new Map<string, string>();
    let stdout: string;
    try {
      ({ stdout } = await this.runCommand(['ip', '-j', 'addr', 'show'], SHOW_TIMEOUT_SECONDS));
    } catch (error) {
      const binaryMissing = isBinaryMissing(error);
      this.lastReadWasBinaryMissing = binaryMissing;
      const message = `Failed to read local interface state — aborting tick to preserve current bindings: ${getErrorMessage(error)}`;
      // Missing `ip` is expected on hosts with no VIP assignment; warnIfAssignedWithoutIpTool
      // escalates when the hub actually assigned one.
      if (binaryMissing) {
        void this.logger.debug(message, { jobId: this.jobId });
      } else {
        void this.logger.warning(message, { jobId: this.jobId });
      }
      return { ok: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      void this.logger.warning(
        `Failed to parse 'ip -j addr show' output — aborting tick to preserve current bindings: ${getErrorMessage(error)}`,
        {
          jobId: this.jobId,
        },
      );
      return { ok: false };
    }
    // `ip -j addr show` always emits an array; a non-array is uninterpretable — fail closed, not "nothing bound".
    if (!Array.isArray(parsed)) {
      void this.logger.warning(
        "Unexpected 'ip -j addr show' output (not an array) — aborting tick to preserve current bindings",
        { jobId: this.jobId },
      );
      return { ok: false };
    }

    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const ifname = entry.ifname;
      const addrInfo = entry.addr_info;
      if (typeof ifname !== 'string' || !Array.isArray(addrInfo)) continue;
      for (const addr of addrInfo) {
        if (!isRecord(addr)) continue;
        if (addr.label !== VRRP_LABEL) continue;
        const local = addr.local;
        const prefixlen = addr.prefixlen;
        if (typeof local !== 'string' || typeof prefixlen !== 'number') continue;
        actual.set(`${local}/${prefixlen}`, ifname);
      }
    }
    return { ok: true, value: actual };
  }
}
