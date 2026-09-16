import { ConflictException, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { catchError, EMPTY, lastValueFrom, Observable, takeUntil, tap, timeout, timer } from 'rxjs';
import { z } from 'zod';

import { ApplyPlanSchema, type ApplyPlan, type FleetPending, type FleetPlanes } from '@repo/local-lab-contract';
import { getErrorMessage } from '@repo/utils';
import { ipxeChainBaseUrl } from '../common/ipxe-chain-url';
import type { StackOp } from '../contract';
import { FleetResetService } from '../fleet/fleet-reset.service';
import { FleetStatusService } from '../fleet/fleet-status.service';
import { FleetTopologyService } from '../fleet/fleet-topology.service';
import { UplinkPrefixService } from '../fleet/uplink-prefix.service';
import { resolvePgUrl } from '../ports';
import { runBacklog, RunnerService, type RunState } from '../runner/runner.service';
import { planesEqual, VM_ONLY } from '../services/applied-manifest';
import { applyScopeNamespaces, applyScopeProcesses } from '../services/apply-scope';
import { parseEnvEntries } from '../services/env-entries';
import type { FleetStatus } from '../services/fleet-health';
import { diagnoseGateTimeout } from '../services/flip-gate-diagnosis';
import { swapDiffSet } from '../services/mode-drift';
import { OverlayStoreService } from '../services/overlay-store';
import { devenvRoot } from '../services/paths';
import {
  classifyProc,
  depsReady,
  ProcessComposeClient,
  procIsDepReady,
  procIsUp,
  type PcProcess,
  type ProcDiag,
} from '../services/process-compose.client';
import { RedeployService } from '../services/redeploy.service';
import { datastoreIds, RenderedConfigService, resolveCatalog } from '../services/rendered-config.service';
import { RepoBranchService } from '../services/repo-branch.service';
import type { RestartWipe } from '../services/restart-marker';
import { StackRestartService } from '../services/stack-restart.service';
import { SudoService } from '../sudo/sudo.service';
import { STACK_OPS, ZONE_SEED_TASKS, type StackOpDef } from './stack-ops';

export { STACK_OPS, type StackOpDef } from './stack-ops';

const execFileP = promisify(execFile);
const StagedRoster = z.array(z.unknown()).default([]);
const StagedFleetSchema = z.object({ nodes: StagedRoster, baremetal: z.object({ nodes: StagedRoster }).nullish() });

export class ActiveSagaConflictException extends ConflictException {
  constructor(readonly activeJobs: number) {
    super(
      `${activeJobs} in-flight saga job(s) across the configured zones — a mid-saga plane flip could strand them. Confirm "force apply" to override.`,
    );
  }
}

// Stack ops never tear down the fleet or lab/lab-web IN-PROCESS (that would kill the control center
// mid-request); reinit/reset/purge do it from StackRestartService's detached child, which outlives us.
const SEED_SCRIPT = 'scripts/tasks/sql-seed-run.sh';
const FLEET_PROC = 'fleet';
const SPOKE_PROC = 'spoke';
const HUB_PROC = 'hub-api';

const BM_CAP_ENSURE_SCRIPT = 'scripts/tasks/bm-cap-ensure.sh';

// the ipxe build pulls docker/dockerfile:1 from Docker Hub; a refused lookup is the one failure an operator fixes outside the lab
const DOCKER_HUB_DNS_FAILURE = /lookup registry-1\.docker\.io|registry-1\.docker\.io.*no such host/;

const ZONE_SEED_REQUIRED_PROCS = [HUB_PROC, 'redis', 'postgres'];

const SWAP_ALLOWED_PROCS = new Set([SPOKE_PROC, HUB_PROC, FLEET_PROC]);
const FLIP_SCOPE = applyScopeProcesses(SWAP_ALLOWED_PROCS);

// zone-seed re-credentials the bridges and restarts them; nothing else may be recreated under it.
const ZONE_SEED_SCOPE = applyScopeNamespaces('spoke');

// `local.fleet apply` exit code for "bare-metal drift, converge it from the lab" (fleet.py cmd_apply).
const BM_DRIFT_EXIT = 3;

@Injectable()
export class StackService implements OnApplicationBootstrap {
  private readonly log = new Logger(StackService.name);
  private readonly inFlight = new Map<string, RunState>();

  constructor(
    private readonly runner: RunnerService,
    private readonly redeploy: RedeployService,
    private readonly overlay: OverlayStoreService,
    private readonly rendered: RenderedConfigService,
    private readonly pc: ProcessComposeClient,
    private readonly fleetStatus: FleetStatusService,
    private readonly fleet: FleetTopologyService,
    private readonly fleetReset: FleetResetService,
    private readonly repoBranch: RepoBranchService,
    private readonly sudo: SudoService,
    private readonly stackRestart: StackRestartService,
    private readonly uplinkPrefix: UplinkPrefixService,
  ) {}

  onApplicationBootstrap(): void {
    void this.rendered.catalogOrEmpty().then((catalog) => {
      if (catalog.size === 0) return;
      this.controllableIds = new Set(
        [...catalog].filter(([, c]) => c.namespace === 'datastore' || c.namespace === 'fleet').map(([id]) => id),
      );
    });
    this.surfaceUnfinishedFlip();
  }

  private surfaceUnfinishedFlip(): void {
    const p = this.applyJournalPath();
    if (!p) return;
    let last: { phase?: unknown; opId?: unknown } | null = null;
    let torn = false;
    try {
      const lines = readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      if (lines.length === 0) return;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed: unknown = JSON.parse(lines[i]);
          if (typeof parsed === 'object' && parsed !== null) {
            last = parsed;
            torn = i !== lines.length - 1;
            break;
          }
        } catch {
          torn = true;
        }
      }
    } catch {
      return;
    }
    const phase = last && typeof last.phase === 'string' ? last.phase : null;
    if (!phase) return;
    // The same apply-journal is written by the incremental fleet-apply roster steps (opId
    // 'fleet-apply'); only a real plane flip ('fleet-planes-apply') should synthesize a crashed-flip run.
    const opId = last && typeof last.opId === 'string' ? last.opId : null;
    if (opId !== 'fleet-planes-apply') return;
    if ((phase === 'done' || phase === 'failed') && !torn) return;
    const run = this.runner.create({ section: 'stack', opId: 'fleet-planes-apply', label: 'fleet-planes-apply' });
    const msg =
      phase === 'done' || phase === 'failed'
        ? `[planes] apply journal ends mid-write after phase ${phase} — if the last Apply visibly succeeded this is stale; re-Apply is a safe no-op, otherwise it converges\n`
        : `[planes] control center restarted mid-flip at phase ${phase} — re-Apply to converge\n`;
    this.runner.emit(run, msg);
    this.runner.finalize(run, 1);
    try {
      appendFileSync(
        p,
        JSON.stringify({ runId: run.runId, opId: 'fleet-planes-apply', phase: 'failed', ts: Date.now() }) + '\n',
      );
    } catch {
      /* empty */
    }
  }

  ops(): StackOp[] {
    return STACK_OPS.map(({ sections, ...pub }) => pub);
  }

  private controllableIds = new Set<string>();

  async state(): Promise<{
    datastoresUp: boolean;
    datastores: ({ id: string; label: string } & ProcDiag)[];
    fleetProcesses: ({ id: string; label: string } & ProcDiag)[];
    fleet: FleetStatus;
    fleetPending?: FleetPending;
  }> {
    let byName = new Map<string, PcProcess>();
    let graph: Record<string, string[]> = {};
    try {
      byName = new Map((await this.pc.listAll()).map((p) => [p.name, p]));
      graph = await this.rendered.dependsGraph();
    } catch (error) {
      this.log.debug(`state: process list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const diag = (id: string): ProcDiag => classifyProc(byName.get(id), depsReady(id, byName, graph));
    const catalog = await this.rendered.catalogOrEmpty();
    const dsDefs = [...catalog]
      .filter(([, c]) => c.namespace === 'datastore')
      .map(([id, c]) => ({ id, label: c.label }));
    const fleetDefs = [...catalog]
      .filter(([, c]) => c.namespace === 'fleet')
      .map(([id, c]) => ({ id, label: c.label }));
    const freshIds = new Set([...dsDefs, ...fleetDefs].map((d) => d.id));
    // Gate on catalog.size, not freshIds.size — a failed build (empty map) must not wipe the warmed set, but a valid config with no datastore/fleet procs should clear it.
    if (catalog.size > 0) this.controllableIds = freshIds;
    const datastores = dsDefs.map((d) => ({ id: d.id, label: d.label, ...diag(d.id) }));
    const fleetProcesses = fleetDefs
      .filter((d) => byName.has(d.id))
      .map((d) => ({ id: d.id, label: d.label, ...diag(d.id) }));
    const datastoresUp = dsDefs.length > 0 && dsDefs.every((d) => diag(d.id).status === 'up');
    const fleet = await this.fleetStatus.status();
    const fleetPending = await this.fleet.pending().catch(() => undefined);
    return { datastoresUp, datastores, fleetProcesses, fleet, fleetPending };
  }

  async controlDatastore(id: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; detail?: string }> {
    if (!this.controllableIds.has(id)) throw new NotFoundException(`unknown process '${id}'`);
    // Don't let per-process control race a lifecycle op over the same pc socket (the UI gates this too, but a second tab would slip through).
    const busy = this.runningLifecycleOp('stack');
    if (busy)
      throw new ConflictException(`stack busy: '${busy.label}' is running — stop it before controlling '${id}'`);
    this.log.log(`process ${action}: ${id}`);
    return this.redeploy.control(id, action);
  }

  streamDatastoreLog(id: string): Observable<string> {
    if (!this.controllableIds.has(id)) throw new NotFoundException(`unknown process '${id}'`);
    return this.pc.streamLog(id);
  }

  private static opById(id: string): StackOpDef | undefined {
    return STACK_OPS.find((o) => o.id === id);
  }

  private static opLanes(op: StackOpDef): Set<StackOp['section']> {
    return new Set<StackOp['section']>([op.section, ...(op.sections ?? [])]);
  }

  private runningLifecycleOp(section: StackOp['section']): RunState | undefined {
    for (const run of this.inFlight.values()) {
      const op = StackService.opById(run.opId);
      if (op && op.group !== 'status' && StackService.opLanes(op).has(section)) return run;
    }
    return undefined;
  }

  async startRun(opId: string, allowDataLoss = false, force = false): Promise<string> {
    if (opId === 'fleet-planes-apply' && !force && this.fleet.planesChangePending()) {
      const activeJobs = await this.fleetReset.countActiveSagaJobs().catch(() => 0);
      if (activeJobs > 0) throw new ActiveSagaConflictException(activeJobs);
    }
    // start() is sync (callers depend on its `string` return), so the async sudo gate lives here; it
    // fails as a run — and mints its own, since nothing outside start() does — not as an HTTP error.
    const op = StackService.opById(opId);
    if (op?.needsSudo) {
      const pf = await this.sudo.preflight();
      if (!pf.ok) {
        const run = this.runner.create({ section: 'stack', opId: op.id, label: op.id });
        this.runner.emit(run, `\n[preflight] ${pf.reason}\n`);
        this.runner.finalize(run, 1);
        return run.runId;
      }
    }
    return this.start(opId, allowDataLoss, force);
  }

  start(opId: string, allowDataLoss = false, force = false): string {
    const op = StackService.opById(opId);
    if (!op) throw new NotFoundException(`unknown stack op '${opId}'`);

    // Single-flight per lane — without this, reconcile + restart spawn two competing
    // `stack-reconcile` healers that thrash the process-compose socket and wedge the stack.
    if (op.group !== 'status') {
      for (const lane of StackService.opLanes(op)) {
        const conflict = this.runningLifecycleOp(lane);
        if (conflict)
          throw new ConflictException(
            `stack busy: '${conflict.label}' is already running (runId=${conflict.runId}). Stop it first.`,
          );
      }
    }

    const run = this.runner.create({ section: 'stack', opId: op.id, label: op.id });
    this.log.log(`run ${run.runId}: ${op.id}`);
    // The .catch finalizes a throwing phase — otherwise the run hangs `running` and the lane never frees.
    this.inFlight.set(run.runId, run);
    void this.orchestrate(op.id, run, allowDataLoss, force)
      .catch((e) => {
        this.runner.emit(run, `\n[orchestrate error] ${getErrorMessage(e)}\n`);
        this.runner.finalize(run, 1);
      })
      .finally(() => this.inFlight.delete(run.runId));
    return run.runId;
  }

  private async controlPlaneUp(run: RunState): Promise<number | null> {
    this.runner.emit(run, '\n[reconcile] bringing the control plane to ready — datastores → hub → spoke\n\n');
    const rc = await this.runner.spawn(run, 'stack-reconcile', []);
    if (run.cancelled) return null;
    if (rc !== 0)
      this.runner.emit(run, `\n[reconcile] some processes are not ready yet (exit ${rc}) — seeding anyway\n`);
    this.runner.emit(run, '\n[post] seeding the hub DB\n\n');
    return this.runner.spawn(run, 'bash', [SEED_SCRIPT]);
  }

  private async controlPlaneDown(run: RunState): Promise<number> {
    this.runner.emit(
      run,
      '\n[teardown] stopping hub + spoke, then the datastores — fleet + control center untouched\n\n',
    );
    // If the catalog can't be built, do NOT proceed — a silent "stopped nothing" teardown would report success, and a following nuke would wipe live data dirs.
    let dsIds: string[];
    try {
      dsIds = datastoreIds(await this.rendered.catalog());
    } catch (e) {
      this.runner.emit(
        run,
        `\n[teardown] FAILED: could not resolve the process catalog (${getErrorMessage(e)}) — stack NOT stopped. Check the devenv build.\n`,
      );
      return 1;
    }
    this.redeploy.stopAll();
    // pc.stop only acks the REST call — wait for terminal states so a following nuke can't wipe under a still-running datastore.
    const results = await Promise.all(
      dsIds.map(async (id) => ({
        id,
        ok: await this.raceCancelled(
          run,
          this.pc.stopAndWait(id).catch(() => false),
        ),
      })),
    );
    if (run.cancelled) {
      this.runner.emit(run, '\n[teardown] cancelled — remaining datastore stops left to process-compose\n');
      return 1;
    }
    for (const { id, ok } of results) {
      this.runner.emit(run, ok ? `[teardown] ${id} stopped\n` : `[teardown] ${id} did not reach a stopped state\n`);
    }
    const stuck = results.filter((r) => !r.ok).map((r) => r.id);
    if (stuck.length > 0) {
      this.runner.emit(run, `\n[teardown] FAILED: ${stuck.join(', ')} never stopped — aborting\n`);
      return 1;
    }
    return 0;
  }

  /** Caps a teardown wait at cancellation so a cancelled run releases its op lane promptly instead of holding it for the full stopAndWait timeout. */
  private async raceCancelled(run: RunState, wait: Promise<boolean>): Promise<boolean> {
    let settled = false;
    const guarded = wait.finally(() => {
      settled = true;
    });
    const cancelPoll = (async () => {
      while (!settled && !run.cancelled) await new Promise((r) => setTimeout(r, 250));
      return false;
    })();
    return Promise.race([guarded, cancelPoll]);
  }

  /** If cancelled mid-teardown, bail before bringing the plane back up — a SIGTERM'd restart would otherwise still spawn a `stack-reconcile` and race whatever the user started instead. */
  private async controlPlaneRestart(run: RunState): Promise<number | null> {
    const downCode = await this.controlPlaneDown(run);
    if (run.cancelled) return null;
    if (downCode !== 0) return downCode;
    return this.controlPlaneUp(run);
  }

  private async controlPlaneNuke(run: RunState): Promise<number | null> {
    const downCode = await this.controlPlaneDown(run);
    if (run.cancelled) return null;
    if (downCode !== 0) {
      // Refuse the wipe — wiping data dirs under a still-running postgres/redis corrupts them.
      this.runner.emit(run, `\n[nuke] aborting the data wipe — teardown failed; the datastores may still be running\n`);
      return downCode;
    }
    this.runner.emit(run, `\n[nuke] wiping datastore data via stack-wipe-data\n\n`);
    const code = await this.runner.spawn(run, 'stack-wipe-data', []);
    this.runner.emit(
      run,
      '\n[nuke] data wiped, and NOT re-initialized — Stack up reconciles processes but does not re-run ' +
        'the init DAG (migrate / device seed). Run Reinit instead to wipe and rebuild in one op; from ' +
        'here, Stack up → DB migrate deploy → Seed DB gets you back.\n',
    );
    return code;
  }

  private async dbDrift(run: RunState): Promise<number | null> {
    const root = this.repoBranch.repoPath();
    if (!root) {
      this.runner.emit(run, '[db] hub checkout path unset (HUB_REPO_PATH) — cannot run prisma\n');
      return 1;
    }
    this.runner.emit(run, '\n[drift] diffing the live hub schema against the prisma schema\n\n');
    const code = await this.runner.spawn(
      run,
      'pnpm',
      ['--filter', '@repo/database', 'db:drift'],
      { DATABASE_URL: resolvePgUrl() },
      { cwd: root },
    );
    // spawn's finalize marks any non-zero as failed; the interpreting line disambiguates exit 2 (drift) from a real error.
    if (code === 0) this.runner.emit(run, '\n[drift] live schema matches the prisma schema\n');
    else if (code === 2)
      this.runner.emit(run, '\n[drift] schema differs — run DB migrate deploy, or Reinit for a clean rebuild\n');
    else this.runner.emit(run, '\n[drift] check errored\n');
    return code;
  }

  private async dbMigrateDeploy(run: RunState): Promise<number | null> {
    const root = this.repoBranch.repoPath();
    if (!root) {
      this.runner.emit(run, '[db] hub checkout path unset (HUB_REPO_PATH) — cannot run prisma\n');
      return 1;
    }
    this.runner.emit(run, '\n[migrate] applying pending migrations to the hub DB\n\n');
    const code = await this.runner.spawn(
      run,
      'pnpm',
      ['--filter', '@repo/database', 'db:migrate:deploy'],
      { DATABASE_URL: resolvePgUrl() },
      { cwd: root },
    );
    if (code === 0) this.runner.emit(run, '\n[migrate] hub DB is up to date\n');
    return code;
  }

  private async fleetUp(run: RunState): Promise<number | null> {
    this.runner.emit(run, `\n[fleet] starting the '${FLEET_PROC}' process\n\n`);
    return this.startFleetProcess(run);
  }

  private async fleetDown(run: RunState): Promise<number | null> {
    this.runner.emit(
      run,
      `\n[fleet] down: power off the VMs + stop ipmi_sim/sushy (domains stay defined for a fast next up; overlays kept), then stop the process\n\n`,
    );
    const logBefore = this.fleetLogSize();
    // Engine teardown runs directly, not via the supervisor's SIGTERM handler — pc's stop timeout could SIGKILL it mid-teardown and leak running domains.
    const code = await this.runner.spawn(run, 'python', ['-m', 'local.fleet', 'down']);
    await this.pc.stopAndWait(FLEET_PROC);
    await this.streamFleetLog(run, logBefore, 15_000);
    return code;
  }

  private async fleetNuke(run: RunState): Promise<number | null> {
    this.runner.emit(run, '\n[fleet] nuke: tear down + delete overlays, NVRAM, and sushy configs\n\n');
    try {
      const code = await this.runner.spawnPty(run, 'python', ['-m', 'local.fleet', 'nuke']);
      await this.pc.stopAndWait(FLEET_PROC);
      return code;
    } finally {
      this.fleet.invalidatePending();
    }
  }

  private async fleetRebuild(run: RunState): Promise<number | null> {
    this.runner.emit(run, '\n[fleet] rebuild: refresh config → nuke → seed → build artifacts → power on\n\n');
    // A destructive nuke/rebuild against the wrong applied planes is exactly what the sibling ops
    // refuse; guard here too so the planes-change banner's fleet-planes-apply is the only next step.
    if (this.fleet.planesChangePending()) {
      this.runner.emit(
        run,
        '[fleet] rebuild blocked: a fleet plane change is pending — apply it via Fleet → Apply (fleet-planes-apply) first\n',
      );
      return 1;
    }
    try {
      const fleetPath = await this.rendered.refreshFleetYaml();
      if (!fleetPath) {
        this.runner.emit(run, '[fleet] could not refresh the saved fleet config — aborting rebuild\n');
        return 1;
      }
      const fleetEnv: Record<string, string> = { LOCAL_FLEET_PATH: fleetPath };
      this.runner.emit(run, `[fleet] fleet config: ${fleetPath}\n`);
      if (run.cancelled) return null;
      const nuke = await this.runner.spawnPty(run, 'python', ['-m', 'local.fleet', 'nuke'], fleetEnv);
      if (nuke !== 0) return nuke;
      const seed = await this.runner.spawn(run, 'bash', [SEED_SCRIPT], fleetEnv);
      if (seed !== 0) return seed;
      const init = await this.runner.spawnPty(run, 'python', ['-m', 'local.fleet', 'init'], fleetEnv);
      if (init !== 0) return init;
      if (run.cancelled) return null;
      this.runner.emit(run, `\n[fleet] (re)starting the '${FLEET_PROC}' process (power on)\n\n`);
      return this.startFleetProcess(run);
    } finally {
      this.fleet.invalidatePending();
    }
  }

  private async fleetAddCommissioning(run: RunState): Promise<number | null> {
    this.runner.emit(run, '\n[commissioning] adding commissioning-candidate nodes to the fleet config\n\n');
    // fleetApply refuses while a plane flip is pending; guard here too so the operator gets an
    // commissioning-context message instead of a mid-stream '[fleet] apply blocked' from the delegate.
    if (this.fleet.planesChangePending()) {
      this.runner.emit(
        run,
        '[commissioning] blocked: a fleet plane change is pending — apply it via Fleet → Apply (fleet-planes-apply) first, then add commissioning nodes\n',
      );
      return 1;
    }
    let saved: { added: string[]; existing: number };
    try {
      saved = await this.fleet.addCommissioningNodesConfig(2);
    } catch (e) {
      this.runner.emit(run, `[commissioning] could not update the fleet config: ${getErrorMessage(e)}\n`);
      return 1;
    }
    if (saved.added.length === 0) {
      this.runner.emit(
        run,
        `[commissioning] fleet already has ${saved.existing} commissioning node(s) — nothing to add; applying to reconcile\n`,
      );
    } else {
      this.runner.emit(
        run,
        `[commissioning] added ${saved.added.join(', ')} (seed_as_server=false) — applying to seed + boot them\n`,
      );
    }
    return this.fleetApply(run, false);
  }

  private async captureApplyPlan(env: Record<string, string>): Promise<ApplyPlan | null> {
    const source = env.LOCAL_FLEET_PATH ?? process.env.LOCAL_FLEET_SOURCE;
    const args = ['-m', 'local.fleet', 'apply', '--plan', ...(source ? ['--source', source] : [])];
    try {
      const { stdout } = await execFileP('python', args, {
        cwd: this.runner.repoRoot,
        env: { ...process.env, ...env },
        timeout: 30_000,
      });
      return ApplyPlanSchema.parse(JSON.parse(stdout));
    } catch (e) {
      this.log.warn(`apply-plan failed: ${getErrorMessage(e)}`);
      return null;
    }
  }

  private async fleetApply(run: RunState, allowDataLoss = false): Promise<number | null> {
    this.runner.emit(run, '\n[fleet] apply: refresh config → plan → minimal ops\n\n');
    // An incremental apply during a pending plane flip would run the engine against the wrong
    // posture; mirrors the redeploy()/reloadGroup() guards in redeploy.service.ts.
    if (this.fleet.planesChangePending()) {
      this.runner.emit(
        run,
        '[fleet] apply blocked: a fleet plane change is pending — apply it via Fleet → Apply (fleet-planes-apply) first\n',
      );
      return 1;
    }
    const fleetPath = await this.rendered.refreshFleetYaml();
    if (!fleetPath) {
      this.runner.emit(run, '[fleet] could not refresh the saved fleet config — aborting apply\n');
      return 1;
    }
    const env: Record<string, string> = { ...this.simTaskEnv(), LOCAL_FLEET_PATH: fleetPath };
    if (run.cancelled) return null;
    const plan = await this.captureApplyPlan(env);
    if (!plan) {
      this.runner.emit(run, '[fleet] could not compute an apply plan\n');
      return 1;
    }
    this.runner.emit(run, `[fleet] plan: ${plan.items.map((i) => `${i.name}=${i.action}`).join(', ') || 'no-op'}\n`);
    // Never escalate a confirmed non-destructive apply into a silent wipe/rebuild — fallbackFullRebuild can be set with dataLoss=false, so guarding dataLoss alone would let a nuke→rebuild slip through.
    if ((plan.dataLoss || plan.fallbackFullRebuild) && !allowDataLoss) {
      const why = plan.fallbackFullRebuild
        ? 'now forces a full rebuild (every node is nuked and recreated)'
        : 'now wipes a node disk';
      this.runner.emit(run, `[fleet] plan ${why} but it was not confirmed — aborting; re-apply to confirm\n`);
      return 1;
    }
    if (plan.fallbackFullRebuild || plan.items.some((i) => i.action === 'add-node')) {
      this.runner.emit(run, '[fleet] seeding hub (add-node / full-rebuild needs Device rows)\n');
      const seed = await this.runner.spawn(run, 'bash', [SEED_SCRIPT], env);
      if (seed !== 0) return seed;
    }
    if (run.cancelled) return null;
    const flags = plan.dataLoss ? ['--allow-data-loss'] : [];
    const rc = await this.runner.spawnPty(run, 'python', ['-m', 'local.fleet', 'apply', ...flags], env);
    // The engine refuses bare-metal roster drift and defers to the lab (fleet.py cmd_apply), so
    // converge it here — otherwise a bm roster edit has no apply path at all.
    if (rc === BM_DRIFT_EXIT && !this.fleet.planesChangePending() && this.overlay.planes().baremetal) {
      return this.applyBmRosterDrift(run, env);
    }
    if (rc !== 0 || run.cancelled) return rc;

    if (!this.fleet.planesChangePending() && this.overlay.planes().baremetal) {
      const bmRc = await this.applyBmRosterSteps(run, env);
      this.journalPhase(run, bmRc === 0 ? 'done' : 'failed');
      if (bmRc !== 0) return bmRc;
    }
    this.fleet.invalidatePending();
    return rc;
  }

  // Roster-only convergence: no overlay swap and no hub/spoke plane restart, just realign the hub
  // rows, redo the host steps, and let the anchor's own `fleet up` commit the applied manifest.
  private async applyBmRosterDrift(run: RunState, env: Record<string, string>): Promise<number | null> {
    this.runner.emit(run, '\n[fleet] bare-metal roster drift — converging without a plane flip\n');
    const seed = await this.runner.spawn(run, 'bash', [SEED_SCRIPT], env);
    if (seed !== 0) {
      this.runner.emit(run, `[fleet] hub seed failed (exit ${seed}) — aborting before the host steps\n`);
      return seed;
    }
    if (run.cancelled) return null;

    const bmRc = await this.applyBmRosterSteps(run, env);
    if (bmRc === null) return null;
    if (bmRc !== 0 || run.cancelled) {
      this.journalPhase(run, 'failed');
      return bmRc;
    }

    this.runner.emit(run, '[fleet] re-anchoring the fleet process to commit the applied manifest\n');
    if (!(await this.pc.stopAndWait(FLEET_PROC))) {
      this.runner.emit(run, '[fleet] fleet anchor did not stop in time — aborting before the re-anchor\n');
      this.journalPhase(run, 'failed');
      return 1;
    }
    this.fleet.invalidatePending();
    const anchor = await this.startFleetProcess(run);
    if (anchor !== 0) {
      this.journalPhase(run, 'failed');
      return anchor;
    }

    if (!(await this.waitFleetInSync(run, 240_000))) {
      this.runner.emit(
        run,
        run.cancelled
          ? '[fleet] cancelled while waiting for the applied manifest\n'
          : '[fleet] anchor did not commit the applied manifest within 240s — see fleet logs\n',
      );
      this.journalPhase(run, 'failed');
      return run.cancelled ? null : 1;
    }
    this.journalPhase(run, 'done');
    this.runner.emit(run, '\n[fleet] bare-metal roster applied\n');
    return 0;
  }

  private async waitFleetInSync(run: RunState, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (run.cancelled) return false;
      this.fleet.invalidatePending();
      if ((await this.fleet.pending()).inSync) return true;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    return false;
  }

  private async applyBmRosterSteps(run: RunState, env: Record<string, string>): Promise<number | null> {
    const rebake = await this.applyBmRebake(run, env);
    if (rebake !== 0) return rebake;
    if (run.cancelled) return null;

    const seal = await this.sealBmCreds(run, env);
    if (seal !== 0) return seal;
    if (run.cancelled) return null;

    this.journalPhase(run, 'gate');
    this.runner.emit(run, '[planes] restarting spoke\n');
    if (!(await this.pc.restartAndWait(SPOKE_PROC))) {
      this.runner.emit(run, '[planes] spoke restart failed (stop or start) — aborting before the gate\n');
      return 1;
    }
    const gated = await this.waitProcessesReady(run, [SPOKE_PROC], 120_000);
    if (!gated) {
      this.runner.emit(run, '[planes] timed out waiting for spoke to become Ready — check its logs\n');
      return 1;
    }
    return 0;
  }

  private async fleetPlanesApply(run: RunState, force: boolean): Promise<number | null> {
    const desired = this.overlay.planes();
    this.runner.emit(run, `\n[planes] apply fleet planes → vm=${desired.vm} baremetal=${desired.baremetal}\n\n`);

    // No-op short-circuit BEFORE the saga guard: already-applied planes must exit 0 even with
    // in-flight jobs (the Fleet op-list launch skips the 409 preflight when nothing is pending).
    if (!this.fleet.planesChangePending()) {
      this.runner.emit(run, '[planes] already applied — nothing to flip\n');
      return 0;
    }

    let activeJobs = 0;
    try {
      activeJobs = await this.fleetReset.countActiveSagaJobs();
    } catch (e) {
      this.runner.emit(
        run,
        `[planes] active-saga guard could not read Redis (${e instanceof Error ? e.message : String(e)}) — treating as 0\n`,
      );
    }
    if (activeJobs > 0 && !force) {
      this.runner.emit(
        run,
        `[planes] BLOCKED: ${activeJobs} in-flight saga job(s) across the configured zones — a mid-saga flip could strand them. Re-apply with "force apply" to override.\n`,
      );
      return 1;
    }
    if (activeJobs > 0) {
      this.runner.emit(run, `[planes] forcing the flip despite ${activeJobs} in-flight saga job(s) (user confirmed)\n`);
    }

    const rc = await this.runFlip(run, desired);
    this.journalPhase(run, rc === 0 ? 'done' : 'failed');
    return rc;
  }

  private async applyBmRebake(run: RunState, env: Record<string, string>): Promise<number | null> {
    this.journalPhase(run, 'cap');
    this.runner.emit(run, '[planes] ensuring the ambient-cap binary (bm-cap-ensure)\n');
    const cap = await this.runner.spawn(run, 'bash', [BM_CAP_ENSURE_SCRIPT], env);
    if (cap !== 0) {
      this.runner.emit(
        run,
        `[planes] cap-ensure failed (exit ${cap}) — the sudoers pin may have rotated; run \`task sudo:setup\` then re-Apply\n`,
      );
      return cap;
    }
    if (run.cancelled) return null;

    this.journalPhase(run, 'bake');
    const uplink = this.overlay.bmUplink();
    if (!uplink) {
      this.runner.emit(
        run,
        '[planes] no bare-metal uplink (mode/NIC/IPv4 unresolved) — aborting before the iPXE rebake\n',
      );
      return 1;
    }
    const chainBase = ipxeChainBaseUrl(uplink);
    if (this.fleet.isIpxeBakedFor(chainBase)) {
      this.runner.emit(run, `[planes] iPXE already baked for ${chainBase} — skipping the rebuild\n`);
      return 0;
    }
    this.runner.emit(run, `[planes] re-baking iPXE with chain URL ${chainBase}\n`);
    const bake = await this.runner.spawnPty(
      run,
      'python',
      ['-m', 'local.ipxe_build', '--chain-base-url', chainBase],
      env,
    );
    if (bake !== 0) {
      if (DOCKER_HUB_DNS_FAILURE.test(runBacklog(run))) {
        this.runner.emit(
          run,
          '[planes] iPXE rebake needs Docker Hub — the resolver refused; fix DNS or pre-pull docker/dockerfile:1, then re-Apply\n',
        );
      }
      this.runner.emit(run, `[planes] iPXE rebake failed (exit ${bake}) — aborting before the swap\n`);
    }
    return bake;
  }

  // Read from the LIVE hub, not the rendered config: the seal must use the key the running hub can
  // reopen, and a render that drifted since bring-up would seal secrets the hub cannot decrypt.
  private async liveHubZoneKey(): Promise<string | null> {
    try {
      const info = await this.pc.processInfo(HUB_PROC);
      return (
        parseEnvEntries(info.environment ?? [])
          .get('BROKKR_HUB_PRIVATE_KEY')
          ?.trim() || null
      );
    } catch (e) {
      this.log.debug(`hub zone key unavailable: ${getErrorMessage(e)}`);
      return null;
    }
  }

  // The bm seal + engine scripts are sim-gated (seed-baremetal-bmc-secrets refuses without these),
  // so every path that runs them — flip AND incremental apply — must pass the same set.
  private simTaskEnv(): Record<string, string> {
    return {
      LOCAL_SIMULATION_ENABLED: 'true',
      HH_ENV: process.env.HH_ENV ?? 'dev',
      DATABASE_URL: resolvePgUrl(),
    };
  }

  private async sealBmCreds(run: RunState, env: Record<string, string>): Promise<number | null> {
    this.journalPhase(run, 'seal');
    // Seal-only: without it DeviceSecretService is dormant and every node is skipped, but no other
    // child needs the zone private key.
    const zoneKey = process.env.BROKKR_HUB_PRIVATE_KEY?.trim() || (await this.liveHubZoneKey());
    if (!zoneKey) {
      this.runner.emit(run, '[planes] no hub zone key resolved — the BMC seal will skip every node\n');
    }
    const sealEnv = zoneKey ? { ...env, BROKKR_HUB_PRIVATE_KEY: zoneKey } : env;
    this.runner.emit(run, '[planes] sealing bare-metal BMC creds\n');
    const seal = await this.runner.spawn(run, 'pnpm', ['--filter', 'api', 'seed:baremetal-bmc'], sealEnv);
    if (seal !== 0) {
      this.runner.emit(run, `[planes] BMC cred seal failed (exit ${seal}) — aborting before the swap\n`);
    }
    return seal;
  }

  private async runFlip(run: RunState, desired: FleetPlanes): Promise<number | null> {
    const bm = desired.baremetal;
    this.journalPhase(run, 'guard');

    this.runner.emit(run, '[planes] force-rendering the new config (refresh-eval-cache)\n');
    let cfgPath: string;
    try {
      cfgPath = await this.rendered.buildRenderedConfig({ refreshEvalCache: true });
    } catch (e) {
      this.runner.emit(
        run,
        `[planes] could not render the new config (${e instanceof Error ? e.message : String(e)}) — aborting (stack still on the prior planes)\n`,
      );
      return 1;
    }
    this.runner.emit(run, `[planes] rendered config: ${cfgPath}\n`);
    if (run.cancelled) return null;

    let diff: string[] = [];
    try {
      diff = await swapDiffSet(this.pc, cfgPath);
    } catch (e) {
      // Fail-closed: unreadable daemon config = drift UNKNOWN. An empty set would pass the offender
      // check vacuously and restart the control center mid-flip — what the guard exists to prevent.
      this.runner.emit(
        run,
        `[planes] drift guard could not read the daemon config (${e instanceof Error ? e.message : String(e)}) — aborting (stack still on the prior planes)\n`,
      );
      return 1;
    }
    const offenders = diff.filter((n) => !SWAP_ALLOWED_PROCS.has(n));
    this.runner.emit(run, `[planes] swap diff-set: {${diff.join(', ') || '∅'}}\n`);
    // Unconditional — `force` overrides only the active-saga preflight, never this guard: restarting
    // processes outside {spoke, hub-api, fleet} mid-flip is never operator-intended.
    if (offenders.length > 0) {
      this.runner.emit(
        run,
        `[planes] BLOCKED: stack config has drifted since bring-up — the swap would restart ${offenders.join(', ')} (including the control center); run Redeploy (or Reinit) first, then re-Apply.\n`,
      );
      return 1;
    }
    if (run.cancelled) return null;

    const env: Record<string, string> = this.simTaskEnv();

    if (bm) {
      const rebake = await this.applyBmRebake(run, env);
      if (rebake !== 0) return rebake;
      if (run.cancelled) return null;
    }

    this.journalPhase(run, 'stop-fleet');
    this.runner.emit(run, '[planes] stopping the fleet (waiting for terminal state)\n');
    if (!(await this.pc.stopAndWait(FLEET_PROC))) {
      this.runner.emit(
        run,
        '[planes] fleet did not reach a terminal state in time — aborting (stack still on the prior planes)\n',
      );
      return 1;
    }
    if (run.cancelled) return null;
    this.runner.emit(run, '[planes] running the engine teardown for the prior planes (fleet down)\n');
    const down = await this.runner.spawn(run, 'python', ['-m', 'local.fleet', 'down'], env);
    if (down !== 0) {
      this.runner.emit(run, `[planes] engine fleet down failed (exit ${down}) — aborting (planes unchanged)\n`);
      return down;
    }
    if (run.cancelled) return null;

    this.journalPhase(run, 'refresh');
    const fleetPath = await this.rendered.refreshFleetYaml(cfgPath);
    if (!fleetPath) {
      this.runner.emit(
        run,
        '[planes] could not refresh the staged fleet config — aborting (stack still on the prior planes)\n',
      );
      return 1;
    }
    env.LOCAL_FLEET_PATH = fleetPath;
    this.runner.emit(run, `[planes] refreshed fleet config: ${fleetPath}\n`);
    if (run.cancelled) return null;

    this.journalPhase(run, 'seed');
    this.runner.emit(run, '[planes] seeding hub devices for the new planes\n');
    const seed = await this.runner.spawn(run, 'bash', [SEED_SCRIPT], env);
    if (seed !== 0) {
      this.runner.emit(run, `[planes] hub seed failed (exit ${seed}) — aborting before the swap\n`);
      return seed;
    }
    if (run.cancelled) return null;

    if (bm) {
      const seal = await this.sealBmCreds(run, env);
      if (seal !== 0) return seal;
      if (run.cancelled) return null;
    }

    this.journalPhase(run, 'swap');
    this.runner.emit(run, '[planes] applying the overlay — the single restart event (spoke, hub-api, fleet)\n');
    const applied = await this.rendered.applyOverlay(cfgPath, FLIP_SCOPE);
    if (!applied) {
      this.runner.emit(run, '[planes] overlay apply failed — see logs; stack may be mid-swap, run Reconcile\n');
      return 1;
    }
    this.runner.emit(run, '[planes] re-stopping the resurrected fleet anchor\n');
    await this.pc.stopAndWait(FLEET_PROC);
    this.fleet.invalidatePending();

    this.runner.emit(run, '[planes] restarting spoke + hub-api into the new plane posture\n');
    // Stop both before starting either: starting hub-api while the spoke still runs the prior planes
    // would leave the pair straddling two postures for the length of a stop.
    for (const proc of [HUB_PROC, SPOKE_PROC]) {
      if (!(await this.pc.stopAndWait(proc, undefined, { absentIsStopped: false }))) {
        this.runner.emit(
          run,
          `[planes] ${proc} did not stop in time — aborting (stack may be mid-swap, run Reconcile)\n`,
        );
        return 1;
      }
    }
    for (const proc of [HUB_PROC, SPOKE_PROC]) {
      if (!(await this.pc.restartAndWait(proc))) {
        this.runner.emit(
          run,
          `[planes] ${proc} could not be restarted — aborting (stack may be mid-swap, run Reconcile)\n`,
        );
        return 1;
      }
      if (!(await this.pc.waitUntilDepReady(proc))) {
        this.runner.emit(
          run,
          `[planes] ${proc} did not reach Ready after restart — aborting (stack may be mid-swap, run Reconcile)\n`,
        );
        this.runner.emit(run, `${await this.gateDiagnosis([proc])}\n`);
        return 1;
      }
    }

    this.journalPhase(run, 'gate');
    this.runner.emit(run, '[planes] health-gating spoke + hub-api back to Ready\n');
    const gated = await this.waitProcessesReady(run, [SPOKE_PROC, HUB_PROC], 120_000);
    if (!gated) {
      this.runner.emit(run, '[planes] timed out waiting for spoke + hub-api to become Ready\n');
      this.runner.emit(run, `${await this.gateDiagnosis([SPOKE_PROC, HUB_PROC])}\n`);
      return 1;
    }

    const staged = this.stagedPlanes(env.LOCAL_FLEET_PATH);
    if (!planesEqual(staged, desired)) {
      this.runner.emit(
        run,
        '[planes] staged fleet config was clobbered mid-flip — re-staging from the rendered config\n',
      );
      const restaged = await this.rendered.refreshFleetYaml(cfgPath);
      if (!restaged) {
        this.runner.emit(run, '[planes] could not re-stage the fleet config — aborting before the anchor\n');
        return 1;
      }
      env.LOCAL_FLEET_PATH = restaged;
    }

    this.journalPhase(run, 'anchor');
    this.runner.emit(run, `[planes] starting the '${FLEET_PROC}' anchor\n`);
    await this.startFleetProcess(run);
    this.fleet.invalidatePending();

    const deadline = Date.now() + 240_000;
    let committed = false;
    while (Date.now() < deadline) {
      if (run.cancelled) break;
      this.fleet.invalidatePending();
      if (!this.fleet.planesChangePending()) {
        committed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    if (!committed) {
      this.runner.emit(run, '[planes] anchor did not commit the applied manifest within 240s — see fleet logs\n');
      return 1;
    }
    this.runner.emit(run, `\n[planes] flip complete — vm=${desired.vm} baremetal=${desired.baremetal}\n`);
    // Verdict is the committed manifest, not the anchor's exit code — a post-commit SIGTERM/teardown
    // race can make it exit non-zero without meaning the flip failed.
    return 0;
  }

  private stagedPlanes(path: string): FleetPlanes {
    try {
      const doc = StagedFleetSchema.parse(loadYaml(readFileSync(path, 'utf8')));
      return { vm: doc.nodes.length > 0, baremetal: (doc.baremetal?.nodes.length ?? 0) > 0 };
    } catch {
      return VM_ONLY;
    }
  }

  private applyJournalPath(): string | null {
    const state = process.env.DEVENV_STATE;
    return state ? join(state, 'baremetal', 'apply-journal.json') : null;
  }

  private journalPhase(run: RunState, phase: string): void {
    const p = this.applyJournalPath();
    if (!p) return;
    try {
      mkdirSync(join(p, '..'), { recursive: true });
      appendFileSync(p, JSON.stringify({ runId: run.runId, opId: run.opId, phase, ts: Date.now() }) + '\n');
    } catch (e) {
      this.log.warn(`apply-journal write (${phase}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async waitProcessesReady(run: RunState, names: string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (run.cancelled) return false;
      try {
        const byName = new Map((await this.pc.listAll()).map((p) => [p.name, p]));
        if (names.every((n) => procIsDepReady(byName.get(n)))) return true;
      } catch (error) {
        this.log.debug(`waitProcessesReady poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  }

  private async gateDiagnosis(names: string[]): Promise<string> {
    let procs: PcProcess[] = [];
    try {
      procs = await this.pc.listAll();
    } catch (error) {
      this.log.debug(`gate diagnosis roster read failed: ${getErrorMessage(error)}`);
    }
    return diagnoseGateTimeout(
      names,
      procs,
      (n) => this.pc.tailError(n) ?? this.pc.tailFileLast(this.pc.taskLogFile(n)),
    );
  }

  /** The direct `fleet up` fallback must stay a true last resort — a false negative races the supervised run over ipmi_sim/sushy/libvirt state and corrupts it. */
  private async startFleetProcess(run: RunState): Promise<number | null> {
    const logBefore = this.fleetLogSize();
    try {
      await this.pc.ensureRunning(FLEET_PROC);
      if (await this.waitFleetRunning(15_000)) {
        await this.streamFleetLog(run, logBefore, 120_000);
        return 0;
      }
    } catch (error) {
      this.log.warn(
        `startFleetProcess: supervised start failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.runner.emit(run, '[fleet] process-compose could not start the fleet — running directly\n\n');
    return this.runner.spawnPty(run, 'python', ['-m', 'local.fleet', 'up']);
  }

  /** Polls pc status, not log growth (the supervised process block-buffers stdout); never early-return on a terminal state — `ensureRunning`'s restart transiently reports `Stopped` before relaunching. */
  private async waitFleetRunning(timeoutMs: number): Promise<boolean> {
    const live = new Set(['running', 'pending', 'launching', 'restarting']);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const proc = (await this.pc.listAll()).find((p) => p.name === FLEET_PROC);
        if (proc && live.has(proc.status.toLowerCase())) return true;
      } catch (error) {
        this.log.debug(`waitFleetRunning poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private fleetLogSize(): number {
    try {
      return statSync(this.pc.logFile(FLEET_PROC)).size;
    } catch {
      return 0;
    }
  }

  /** Waits the full deadline for the first line, then stops ~5s after growth ceases; maxWaitMs is a hard cap either way. */
  private async streamFleetLog(run: RunState, offsetBefore: number, maxWaitMs: number): Promise<void> {
    const output = this.pc.followFile(this.pc.logFile(FLEET_PROC), { startOffset: offsetBefore }).pipe(
      tap((line) => this.runner.emit(run, line.replace(/\r?\n/g, '\r\n'))),
      timeout({ first: maxWaitMs, each: 5_000 }),
      takeUntil(timer(maxWaitMs)),
      catchError(() => EMPTY),
    );
    await lastValueFrom(output, { defaultValue: undefined });
  }

  /** Returns 0 for the caller's `done` because the run is finalized exactly once at the detach point;
   *  a refusal or launch failure has already finalized non-zero, and finalize ignores a settled run. */
  private async detachedRestart(run: RunState, reason: string, wipe: RestartWipe): Promise<number> {
    await this.stackRestart.restartStackDetached(run, { reason, wipe });
    return 0;
  }

  /** `--mode single` runs each task against the stack as it stands, so a down process must fail here
   *  under its own name, not 240s later inside sql-seed-run.sh as a missing-org timeout. */
  private async zoneSeedBlocker(): Promise<string | null> {
    let byName: Map<string, PcProcess>;
    try {
      byName = new Map((await this.pc.listAll()).map((p) => [p.name, p]));
    } catch (e) {
      return `the process list could not be read (${getErrorMessage(e)})`;
    }
    const down = ZONE_SEED_REQUIRED_PROCS.filter((name) => !procIsUp(byName.get(name)));
    if (down.length > 0)
      return `${down.join(', ')} ${down.length > 1 ? 'are' : 'is'} not up — run Stack up, then re-run Seed zones`;
    // devenv bakes the whole task list into DEVENV_TASKS at bring-up, and devenv-tasks prefers it over
    // --task-file, so a bridge the supervisor never booted with dies on TaskNotFound however it starts.
    const absent = this.overlay
      .labBridges()
      .map((b) => b.proc)
      .filter((proc) => !byName.has(proc));
    if (absent.length === 0) return null;
    return (
      `${absent.join(', ')} ${absent.length > 1 ? 'are' : 'is'} not supervised, and the process list is ` +
      `fixed at bring-up — recreate the stack with 'task down' then 'task up', which seeds the zone on the way up`
    );
  }

  /** Stops at the first non-zero exit: a later task run against a zone the earlier one did not create
   *  fails in a way that reads like a bug rather than a skipped step. */
  private async zoneSeed(run: RunState): Promise<number | null> {
    const blocker = await this.zoneSeedBlocker();
    if (blocker !== null) {
      this.runner.emit(run, `\n[zone-seed] refusing: ${blocker}\n`);
      return 1;
    }
    for (const task of ZONE_SEED_TASKS) {
      this.runner.emit(run, `\n[zone-seed] ${task}\n\n`);
      // devenv resolves its env from the devenv root, not the runner's engine root. --mode single:
      // each task deps on devenv:processes:*, whose default closure starts a second redis/postgres.
      const rc = await this.runner.spawn(
        run,
        'devenv',
        ['tasks', 'run', task, '--mode', 'single'],
        {},
        { cwd: devenvRoot() },
      );
      if (run.cancelled) return null;
      if (rc !== 0) {
        this.runner.emit(run, `\n[zone-seed] ${task} exited ${rc} — stopping before the tasks that depend on it\n`);
        return rc;
      }
    }
    this.runner.emit(run, '\n[zone-seed] restarting the bridges so they dial the new credentials\n\n');
    try {
      await this.rendered.applyOverlay(undefined, ZONE_SEED_SCOPE);
    } catch (e) {
      this.runner.emit(run, `[zone-seed] the overlay could not be applied: ${getErrorMessage(e)}\n`);
      return 1;
    }
    const catalog = await this.rendered.catalogOrEmpty();
    const spokes = (await this.pc.list())
      .filter((proc) => resolveCatalog(proc.name, catalog)?.entry.namespace === 'spoke')
      .map((proc) => proc.name);
    for (const name of spokes) {
      const res = await this.redeploy.control(name, 'restart');
      this.runner.emit(run, `  ${name} ${res.ok ? 'restarted' : `did not restart — ${res.detail ?? 'no detail'}`}\n`);
      if (!res.ok) return 1;
    }
    this.overlay.clearSatisfiedBy('zone-apply');
    return 0;
  }

  private orchestrate(id: string, run: RunState, allowDataLoss = false, force = false): Promise<void> {
    const done = (c: number | null) => this.runner.finalize(run, c);
    if (id === 'up') return this.controlPlaneUp(run).then(done);
    if (id === 'reconcile') {
      this.runner.emit(
        run,
        '\n[reconcile] self-healing the control plane — (re)start any down process in dependency order\n\n',
      );
      return this.runner.spawn(run, 'stack-reconcile', []).then(done);
    }
    if (id === 'datastores') {
      this.runner.emit(run, `\n[datastores] reconciling the datastore tier\n\n`);
      return this.runner.spawn(run, 'stack-reconcile', [], { RECONCILE_SCOPE: 'datastores' }).then(done);
    }
    if (id === 'down') return this.controlPlaneDown(run).then(done);
    if (id === 'restart') return this.controlPlaneRestart(run).then(done);
    if (id === 'nuke') return this.controlPlaneNuke(run).then(done);
    if (id === 'reinit') return this.detachedRestart(run, 'reinit (nuke + rebuild)', 'stack-wipe-data').then(done);
    if (id === 'reset')
      return this.detachedRestart(run, 'reset (wipe data + fleet overlays)', 'stack-reset').then(done);
    if (id === 'purge') return this.detachedRestart(run, 'purge (pristine devenv state)', 'stack-purge').then(done);
    if (id === 'seed') return this.runner.spawn(run, 'bash', [SEED_SCRIPT]).then(done);
    if (id === 'zone-seed') return this.zoneSeed(run).then(done);
    if (id === 'db-drift') return this.dbDrift(run).then(done);
    if (id === 'db-migrate-deploy') return this.dbMigrateDeploy(run).then(done);
    if (id === 'fleet-status') return this.runner.spawn(run, 'python', ['-m', 'local.status']).then(done);
    if (id === 'fleet-up') return this.fleetUp(run).then(done);
    if (id === 'fleet-down') return this.fleetDown(run).then(done);
    if (id === 'fleet-nuke') return this.fleetNuke(run).then(done);
    if (id === 'fleet-rebuild') return this.fleetRebuild(run).then(done);
    if (id === 'fleet-apply') return this.fleetApply(run, allowDataLoss).then(done);
    if (id === 'fleet-planes-apply') return this.fleetPlanesApply(run, force).then(done);
    if (id === 'fleet-add-commissioning') return this.fleetAddCommissioning(run).then(done);
    if (id === 'baremetal-uplink-prefix')
      return this.uplinkPrefix.configure(run, (text) => this.runner.emit(run, text)).then(done);
    this.runner.finalize(run, 1);
    return Promise.resolve();
  }
}
