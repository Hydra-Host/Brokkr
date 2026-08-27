import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ccBuildInfo } from '../common/build-info';
import { getErrorMessage } from '../common/errors';
import { SingleFlightCache } from '../common/single-flight-cache';
import type { FleetStatus, FleetSummary, HttpProbeResult, InitStatus, Machine, Run, Status } from '../contract';
import { PgService } from '../datastore/pg.service';
import { RedisService } from '../datastore/redis.service';
import { FleetPowerService } from '../fleet/fleet-power.service';
import { FleetStatusService } from '../fleet/fleet-status.service';
import { HOSTS, URLS } from '../ports';
import { RunsService } from '../runs/runs.service';
import { readHostAccess } from '../services/host-access';
import { OverlayStoreService } from '../services/overlay-store';
import { RepoBranchService } from '../services/repo-branch.service';
import { RosterService } from '../services/roster.service';
import { InitTasksService } from '../stack/init-tasks.service';
import { HttpProbeService } from './http-probe.service';

const execFileP = promisify(execFile);

type HubSpokeProbes = { hub: HttpProbeResult; spokes: HttpProbeResult[] };

type FleetSnapshot = { nodes: Status['fleet']; dbReadFailed: boolean; health: FleetStatus | undefined };

const PROBE_FAILURES_BEFORE_DOWN = 2;

const allProbesOk = (probes: HubSpokeProbes): boolean => probes.hub.ok && probes.spokes.every((s) => s.ok);

function summarizeFleet(fleet: Status['fleet']): FleetSummary {
  const byLifecycle: Record<string, number> = {};
  let on = 0;
  let off = 0;
  let unknown = 0;
  for (const node of fleet) {
    if (node.power === 'on') on += 1;
    else if (node.power === 'off') off += 1;
    else unknown += 1;
    if (node.lifecycleStatus !== null) byLifecycle[node.lifecycleStatus] = (byLifecycle[node.lifecycleStatus] ?? 0) + 1;
  }
  return { total: fleet.length, on, off, unknown, byLifecycle };
}

@Injectable()
export class StatusService {
  private readonly log = new Logger(StatusService.name);

  private readonly labRoot = join(__dirname, '..', '..');

  // the staleness check walks labRoot/src on every /api/status poll; cache it so the recursive scan
  // runs at most once per TTL. degrades to "fresh" so a stat/walk failure can't stall the poll.
  private readonly distStalenessCache = new SingleFlightCache<{ distBuiltAt: number | null; stale: boolean }>({
    load: () => this.computeDistStaleness(),
    ttlMs: 30_000,
    degrade: () => ({ distBuiltAt: null, stale: false }),
    onError: (error) => this.log.debug(`dist staleness check failed: ${getErrorMessage(error)}`),
  });

  // probes hit the hub/spoke over HTTP on every poll without one; cache the batch so the dashboard's
  // refetch cadence can't multiply probe traffic, and degrade to absent rather than stall the poll.
  private readonly probeCache = new SingleFlightCache<HubSpokeProbes | undefined>({
    load: () => this.probeRound(),
    ttlMs: 10_000,
    degrade: () => undefined,
  });

  private lastGoodProbes: HubSpokeProbes | undefined;

  private failedProbeRounds = 0;

  constructor(
    private readonly roster: RosterService,
    private readonly overlay: OverlayStoreService,
    private readonly repoBranch: RepoBranchService,
    private readonly power: FleetPowerService,
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly prober: HttpProbeService,
    private readonly runs: RunsService,
    private readonly initTasks: InitTasksService,
    private readonly fleetStatusSvc: FleetStatusService,
  ) {}

  async overview(): Promise<Status> {
    const [app, services, repos, datastores, fleetSnap, probes, ledger, initStatus] = await Promise.all([
      this.app(),
      this.roster.list().catch(() => []),
      this.repos(),
      this.datastores(),
      // an invalid fleet config corrupts index-derived IPs/UUIDs — surface it (→ 500) rather than
      // masking it as an empty fleet; only transient machine-probe failures degrade to [].
      this.fleetSnapshot().catch((error) => {
        if (getErrorMessage(error).startsWith('fleet config invalid')) throw error;
        return { nodes: [], dbReadFailed: false, health: undefined };
      }),
      this.probeCache.get(),
      this.ledgerSnapshot(),
      this.initSummary(),
    ]);
    return {
      app,
      repos,
      services,
      datastores,
      stack: this.stackSummary(),
      hostAccess: readHostAccess(),
      fleet: fleetSnap.nodes,
      fleetDbReadFailed: fleetSnap.dbReadFailed,
      fleetSummary: summarizeFleet(fleetSnap.nodes),
      fleetHealth: fleetSnap.health,
      hubHealth: probes?.hub,
      spokeHealth: probes?.spokes,
      recentRuns: ledger?.recent,
      lastTestRun: ledger?.lastTest,
      initStatus,
    };
  }

  // a host saturated by a second stack coming up loses whole rounds; hold the last good one until a
  // second consecutive round agrees, so one miss can't render a healthy stack as down.
  private async probeRound(): Promise<HubSpokeProbes | undefined> {
    const probes = await this.runProbes().catch((error) => {
      this.log.debug(`hub/spoke probes failed: ${getErrorMessage(error)}`);
      return undefined;
    });
    if (probes && allProbesOk(probes)) {
      this.failedProbeRounds = 0;
      this.lastGoodProbes = probes;
      return probes;
    }
    this.failedProbeRounds += 1;
    if (this.failedProbeRounds < PROBE_FAILURES_BEFORE_DOWN) return this.lastGoodProbes ?? probes;
    return probes;
  }

  private async runProbes(): Promise<HubSpokeProbes> {
    const [hub, spokes] = await Promise.all([
      this.prober.probe(`${URLS.hubBase}/healthcheck`),
      Promise.all(
        this.overlay.labBridges().map((b) => this.prober.probe(`http://${HOSTS.loopback}:${b.port}/api/health`)),
      ),
    ]);
    return { hub, spokes };
  }

  private ledgerSnapshot(): { recent: Run[]; lastTest: Run | undefined } | undefined {
    try {
      return {
        recent: this.runs.list({ limit: 8, offset: 0 }),
        lastTest: this.runs.list({ section: 'test', limit: 1, offset: 0 })[0],
      };
    } catch (error) {
      this.log.debug(`run ledger snapshot failed: ${getErrorMessage(error)}`);
      return undefined;
    }
  }

  private initSummary(): InitStatus | undefined {
    try {
      return this.initTasks.summary();
    } catch (error) {
      this.log.debug(`init summary failed: ${getErrorMessage(error)}`);
      return undefined;
    }
  }

  private async app(): Promise<Status['app']> {
    const startedAt = Date.now() - process.uptime() * 1000;
    const [{ distBuiltAt, stale }, ccBuild] = await Promise.all([this.distStalenessCache.get(), ccBuildInfo()]);
    return {
      pid: process.pid,
      startedAt: Math.round(startedAt),
      uptimeSec: Math.round(process.uptime()),
      memlockLimit: this.memlock(),
      distBuiltAt,
      stale,
      ccBuild,
    };
  }

  private async computeDistStaleness(): Promise<{ distBuiltAt: number | null; stale: boolean }> {
    const distBuiltAt = Math.round(statSync(join(this.labRoot, 'dist', 'main.js')).mtimeMs);
    return { distBuiltAt, stale: this.newerThan(join(this.labRoot, 'src'), distBuiltAt) };
  }

  private memlock(): string {
    try {
      const line = readFileSync('/proc/self/limits', 'utf8')
        .split('\n')
        .find((l) => l.startsWith('Max locked memory'));
      const soft = line?.replace('Max locked memory', '').trim().split(/\s+/)[0];
      return soft ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private newerThan(dir: string, ts: number): boolean {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.newerThan(full, ts)) return true;
        } else if (statSync(full).mtimeMs > ts) {
          return true;
        }
      }
    } catch (error) {
      this.log.debug(`newerThan scan failed: ${(error as Error).message}`);
    }
    return false;
  }

  private async repos(): Promise<Status['repos']> {
    const repoPath = this.repoBranch.repoPath();
    const [lab, repo] = await Promise.all([this.gitInfo(this.labRoot), this.gitInfo(repoPath)]);
    return { lab, hub: repo, spoke: repo };
  }

  private async gitInfo(path: string | undefined): Promise<Status['repos']['lab']> {
    const out = { path: path ?? null, branch: null as string | null, commit: null as string | null, dirty: false };
    if (!path) return out;
    const git = (args: string[]) => execFileP('git', ['-C', path, ...args], { timeout: 5_000 });
    try {
      const [branch, commit, status] = await Promise.all([
        git(['rev-parse', '--abbrev-ref', 'HEAD'])
          .then((r) => r.stdout.trim())
          .catch(() => null),
        git(['rev-parse', '--short', 'HEAD'])
          .then((r) => r.stdout.trim())
          .catch(() => null),
        git(['status', '--porcelain'])
          .then((r) => r.stdout)
          .catch(() => ''),
      ]);
      out.branch = branch && branch !== 'HEAD' ? branch : null;
      out.commit = commit || null;
      out.dirty = status.trim().length > 0;
    } catch (e) {
      this.log.warn(`gitInfo(${path}) failed: ${getErrorMessage(e)}`);
    }
    return out;
  }

  private async datastores(): Promise<Status['datastores']> {
    const [postgres, redis] = await Promise.all([this.pg.probe(), this.redis.probe()]);
    return { postgres, redis };
  }

  private stackSummary(): Status['stack'] {
    return this.overlay.stackSummary();
  }

  private async fleetSnapshot(): Promise<FleetSnapshot> {
    // the machine probe is a virsh spawn; hand the same snapshot to the health composer rather than paying twice
    const machines = await this.power.machines();
    const [fleet, health] = await Promise.all([
      this.fleetNodes(machines),
      this.fleetStatusSvc.status(machines).catch(() => undefined),
    ]);
    return { ...fleet, health };
  }

  private async fleetNodes(machines: Machine[]): Promise<Omit<FleetSnapshot, 'health'>> {
    const db = await this.pg.devicesStatusByName(machines.map((m) => m.name));
    const nodes = machines.map((m) => {
      const row = db.byName.get(m.name);
      return {
        name: m.name,
        power: m.power,
        lifecycleStatus: row?.lifecycleStatus ?? null,
        deviceId: row?.id ?? null,
        gpuModel: row?.gpuModel ?? null,
      };
    });
    return { nodes, dbReadFailed: db.failed };
  }
}
