import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import { RunnerService, type RunState } from '../runner/runner.service';
import { planesEqual, readAppliedPlanes } from './applied-manifest';
import { applyScopeNamespaces } from './apply-scope';
import { OverlayStoreService } from './overlay-store';
import {
  classifyProc,
  depsReady,
  ProcessComposeClient,
  procIsDepReady,
  procIsUp,
  type PcProcess,
} from './process-compose.client';
import { isRollableService, RenderedConfigService, resolveCatalog } from './rendered-config.service';
import { OBSERVABILITY_PROCS, type StackGroup } from './stack-knobs';
import { StackRestartService } from './stack-restart.service';

// A telemetry toggle recreates the sink and the hub/spoke processes that export to it — nothing else.
const TELEMETRY_APPLY_SCOPE = applyScopeNamespaces('observability', 'hub', 'spoke');

type RestartOutcome = 'restarted' | 'failed' | 'skipped';

// 'skipped' is not a failed restart: the process was never touched, so a run log that called it
// "did not restart" described an attempt that never happened.
const RESTART_LINE: Record<RestartOutcome, string> = {
  restarted: 'restarted',
  failed: 'did not restart',
  skipped: 'skipped — a dependency did not come back',
};

@Injectable()
export class RedeployService {
  private readonly log = new Logger(RedeployService.name);

  // Serialize telemetry applies (two quick Saves would race the procs); single-slot coalescing, last-write-wins.
  private telemetryApplyRunning = false;
  private telemetryApplyQueued = false;

  constructor(
    private readonly pc: ProcessComposeClient,
    private readonly rendered: RenderedConfigService,
    private readonly overlay: OverlayStoreService,
    private readonly runner: RunnerService,
    private readonly stackRestart: StackRestartService,
  ) {
    this.overlay.registerTelemetryApplyHook(() => this.requestTelemetryApply());
  }

  async control(id: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; detail?: string }> {
    if (action === 'stop' && (await this.rendered.catalogOrEmpty()).get(id)?.namespace === 'control')
      return {
        ok: false,
        detail: `${id} is restart-only — stopping it would kill the control center. Use restart instead.`,
      };
    if (action === 'stop') {
      try {
        await this.pc.stop(id);
        return { ok: true, detail: `stopping ${id}` };
      } catch (e) {
        return { ok: false, detail: getErrorMessage(e) };
      }
    }
    let byName = new Map<string, PcProcess>();
    let graph: Record<string, string[]> = {};
    try {
      byName = new Map((await this.pc.listAll()).map((p) => [p.name, p]));
      graph = await this.rendered.dependsGraph();
    } catch (error) {
      this.log.warn(`control ${id}: process list unavailable: ${(error as Error).message}`);
    }
    const p = byName.get(id);
    if (action === 'start' && (p?.status ?? '').toLowerCase() === 'running') {
      return procIsUp(p)
        ? { ok: true, detail: `${id} is already running` }
        : { ok: true, detail: `${id} is already running — not ready yet; watch its logs (or restart it).` };
    }
    if (action === 'start' && p && !depsReady(id, byName, graph)) {
      const dep = (graph[id] ?? []).find(
        (d) => byName.get(d) && !procIsUp(byName.get(d)) && (byName.get(d)?.status ?? '').toLowerCase() !== 'disabled',
      );
      return {
        ok: false,
        detail: `${id} can't start — ${dep ?? 'a dependency'} is not ready. Start it (or run Reconcile) first.`,
      };
    }
    const verb: 'start' | 'restart' = action === 'restart' ? 'restart' : 'start';
    try {
      await this.pc[verb](id);
    } catch (e) {
      return { ok: false, detail: getErrorMessage(e) };
    }
    const STEP_MS = 750;
    const MAX_POLLS = 14;
    let procs: PcProcess[] = [];
    let after: PcProcess | undefined;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, STEP_MS));
      try {
        procs = await this.pc.list();
      } catch {
        return { ok: true, detail: `${verb} ${id} issued` };
      }
      after = procs.find((x) => x.name === id);
      if (procIsUp(after)) return { ok: true, detail: `${id} is up` };
    }
    const diag = classifyProc(after, depsReady(id, new Map(procs.map((x) => [x.name, x])), graph));
    if (diag.status === 'unhealthy' || diag.status === 'crashlooping') {
      return {
        ok: true,
        detail: `${id} is starting — not ready yet${diag.restarts ? ` (↻${diag.restarts})` : ''}; watch its logs.`,
      };
    }
    const err = this.pc.tailError(id);
    return {
      ok: false,
      detail: err
        ? `${id} did not come up — ${err}`
        : `${id} did not come up (${diag.detail ?? after?.status ?? 'absent'})`,
    };
  }

  start(id: string): void {
    void this.pc.start(id).catch((e: Error) => this.log.error(`start ${id}: ${e.message}`));
  }

  stop(id: string): void {
    void this.pc.stop(id).catch((e: Error) => this.log.error(`stop ${id}: ${e.message}`));
  }

  restart(id: string): void {
    void this.pc.restart(id).catch((e: Error) => this.log.error(`restart ${id}: ${e.message}`));
  }

  stopAll(): void {
    void Promise.all([this.pc.list(), this.rendered.catalog()])
      .then(([procs, catalog]) =>
        procs
          .filter((p) => isRollableService(resolveCatalog(p.name, catalog)?.entry.namespace ?? ''))
          .forEach((p) => this.stop(p.name)),
      )
      .catch((e: Error) => this.log.error(`stopAll: ${e.message}`));
  }

  redeploy(): RunState {
    const run = this.runner.create({ section: 'stack', opId: 'redeploy', label: 'redeploy' });
    void this.orchestrateRedeploy(run).catch((e) => {
      this.runner.emit(run, `${getErrorMessage(e)}\n`);
      this.runner.finalize(run, 1);
    });
    return run;
  }

  private failIfPlanesChangePending(run: RunState, reason: string): boolean {
    if (planesEqual(this.overlay.planes(), readAppliedPlanes())) return false;
    this.log.warn(reason);
    this.runner.emit(run, `${reason}\n`);
    this.runner.finalize(run, 1);
    return true;
  }

  private async orchestrateRedeploy(run: RunState): Promise<void> {
    if (
      this.failIfPlanesChangePending(
        run,
        'redeploy blocked: a fleet plane change is pending — apply it via Fleet → Apply (fleet-planes-apply) first',
      )
    )
      return;
    if (this.overlay.isRebindPending()) await this.restartStackForRebind(run);
    else await this.applyOverlayAndRestart(run);
  }

  private async restartStackForRebind(run: RunState): Promise<void> {
    await this.stackRestart.restartStackDetached(run, {
      reason: this.overlay.rebindReasonText(),
      wipe: this.overlay.rebindWipeKind(),
      onLaunchFailure: () => this.overlay.armRebindPending(),
    });
    // the service finalizes only a launch failure, so a still-running run means the child detached.
    if (run.status !== 'running') return;
    this.overlay.clearRebindPending();
    this.runner.finalize(run, 0);
  }

  private async groupProcs(group: StackGroup): Promise<string[]> {
    const [procs, catalog] = await Promise.all([this.pc.list(), this.rendered.catalog()]);
    return procs.filter((p) => resolveCatalog(p.name, catalog)?.entry.namespace === group).map((p) => p.name);
  }

  reloadGroup(group: StackGroup): RunState {
    const run = this.runner.create({ section: 'stack', opId: `reload-${group}`, label: `reload-${group}` });
    void this.orchestrateReload(run, group).catch((e) => {
      this.runner.emit(run, `${getErrorMessage(e)}\n`);
      this.runner.finalize(run, 1);
    });
    return run;
  }

  private async orchestrateReload(run: RunState, group: StackGroup): Promise<void> {
    if (
      this.failIfPlanesChangePending(
        run,
        `reload ${group} blocked: a fleet plane change is pending — apply it via Fleet → Apply (fleet-planes-apply) first`,
      )
    )
      return;
    this.runner.emit(run, 'applying overlay\n');
    try {
      await this.rendered.applyOverlay(undefined, applyScopeNamespaces(group));
    } catch (e) {
      const msg = getErrorMessage(e);
      this.log.error(`reload ${group}: overlay regenerate/apply failed: ${msg}`);
      this.runner.emit(run, `overlay regenerate/apply failed: ${msg}\n`);
      this.runner.finalize(run, 1);
      return;
    }
    if (run.status !== 'running') return;
    try {
      const [names, graph] = await Promise.all([this.groupProcs(group), this.rendered.dependsGraph()]);
      if (run.status !== 'running') return;
      this.runner.emit(run, `restarting ${names.length} service${names.length === 1 ? '' : 's'}\n`);
      const first = await this.restartAll(names, graph, (name, outcome) =>
        this.runner.emit(run, `  ${name} ${RESTART_LINE[outcome]}\n`),
      );
      const { failed, skipped } = await this.recoverWedged(run, names, graph, first);
      if (await this.failIfNotUp(run, `reload ${group}`, names, graph, failed, skipped)) return;
      // only on success, and only this group's own class: a hub reload never restarted the spoke, so
      // clearing by rank would drop a spoke path that is still waiting.
      this.overlay.clearSatisfiedBy(group === 'hub' ? 'reload-hub' : 'reload-spoke');
      this.runner.finalize(run, 0);
    } catch (e) {
      const msg = getErrorMessage(e);
      this.log.error(`reload ${group}: restart failed: ${msg}`);
      this.runner.emit(run, `restart failed: ${msg}\n`);
      this.runner.finalize(run, 1);
    }
  }

  /** Fail-soft per stage — the sink must never block the control center; under `deferReload` restarting hub/spokes would come up against un-rebound ports, so re-eval + reload wait for the Redeploy (a disable still stops the sink immediately). */
  private async applyTelemetry(enable: boolean, deferReload: boolean): Promise<void> {
    if (deferReload) {
      if (!enable) await Promise.all(OBSERVABILITY_PROCS.map((n) => this.pc.ensureStopped(n)));
      this.log.log(
        `telemetry apply: ${enable ? 'enable' : 'disable'} deferred to redeploy (datastore/LAN rebind staged)` +
          `${enable ? '' : '; sink stopped'}`,
      );
      return;
    }
    let ok = true;
    let overlayOk = true;
    try {
      await this.rendered.applyOverlay(undefined, TELEMETRY_APPLY_SCOPE);
    } catch (e) {
      ok = false;
      overlayOk = false;
      this.log.error(`telemetry apply: overlay regenerate/apply failed: ${getErrorMessage(e)}`);
    }
    try {
      await Promise.all(OBSERVABILITY_PROCS.map((n) => (enable ? this.pc.ensureRunning(n) : this.pc.ensureStopped(n))));
    } catch (e) {
      ok = false;
      this.log.error(`telemetry apply: observability ${enable ? 'start' : 'stop'} failed: ${getErrorMessage(e)}`);
    }
    if (overlayOk) {
      try {
        const reloadable = (await this.pc.listAll())
          .map((p) => p.name)
          .filter(
            (n) =>
              n === 'hub-api' ||
              n.startsWith('hub-api-') ||
              ((n === 'spoke' || n.startsWith('spoke-')) && !n.endsWith('-telegraf')),
          );
        const { failed, skipped } = await this.restartAll(reloadable, await this.rendered.dependsGraph());
        if (failed.length > 0) {
          ok = false;
          this.log.error(`telemetry apply: services did not restart: ${failed.join(', ')}`);
        }
        if (skipped.length > 0) {
          ok = false;
          this.log.error(`telemetry apply: services skipped after a dependency failed: ${skipped.join(', ')}`);
        }
      } catch (e) {
        ok = false;
        this.log.error(`telemetry apply: hub/spoke reload failed: ${getErrorMessage(e)}`);
      }
    }
    const summary = `telemetry apply: sink ${enable ? 'started' : 'stopped'}${
      overlayOk ? ' + hub/spoke reloaded' : ' (reload skipped — overlay apply failed)'
    }`;
    if (ok) this.log.log(summary);
    else this.log.warn(`${summary} (one or more stages failed — see errors above)`);
  }

  private requestTelemetryApply(): void {
    if (this.telemetryApplyRunning) {
      this.telemetryApplyQueued = true;
      return;
    }
    void this.drainTelemetryApply();
  }

  private async drainTelemetryApply(): Promise<void> {
    this.telemetryApplyRunning = true;
    try {
      do {
        this.telemetryApplyQueued = false;
        await this.applyTelemetry(this.overlay.telemetryEnabled(), this.overlay.isRebindPending());
      } while (this.telemetryApplyQueued);
    } finally {
      this.telemetryApplyRunning = false;
    }
  }

  // A start on a Skipped process is a no-op process-compose reports as a success, so a run's verdict
  // has to come from the state afterwards rather than from any call it made.
  private async verifyUp(
    names: string[],
    graph: Record<string, string[]>,
  ): Promise<{ down: string[]; detail: string[]; probePending: string[] }> {
    const byName = new Map((await this.pc.listAll()).map((p) => [p.name, p]));
    const scope = new Set(names);
    const down = names.filter((n) => !procIsUp(byName.get(n)));
    // procIsUp is lenient where waitUntilDepReady is strict, so a probe that never landed leaves the
    // process out of `down` and its diagnostic empty — the one case the operator most needs named.
    const probePending = names.filter((n) => procIsUp(byName.get(n)) && !procIsDepReady(byName.get(n)));
    const detail = down.map((n) => {
      const status = byName.get(n)?.status ?? 'absent';
      if (status.toLowerCase() !== 'skipped') return `${n} is ${status}`;
      const outside = (graph[n] ?? []).filter((d) => !scope.has(d));
      return outside.length > 0
        ? `${n} is Skipped — only restarting ${outside.join(', ')} clears that, and this run must not touch them; run Redeploy`
        : `${n} is Skipped`;
    });
    return { down, detail, probePending };
  }

  /** Finalizes the run as failed, naming what is broken, and reports whether it did. */
  private async failIfNotUp(
    run: RunState,
    label: string,
    names: string[],
    graph: Record<string, string[]>,
    failed: string[],
    skipped: string[] = [],
  ): Promise<boolean> {
    const { down, detail, probePending } = await this.verifyUp(names, graph);
    for (const n of failed.filter((x) => probePending.includes(x)))
      this.runner.emit(run, `  ${n} is Running but its readiness probe has not passed\n`);
    if (failed.length > 0) {
      this.log.error(`${label}: services did not restart: ${failed.join(', ')}`);
      this.runner.emit(run, `did not restart: ${failed.join(', ')}\n`);
    }
    if (skipped.length > 0) {
      this.log.error(`${label}: services skipped after a dependency failed: ${skipped.join(', ')}`);
      this.runner.emit(run, `skipped after a dependency failed: ${skipped.join(', ')}\n`);
    }
    const stillDown = down.filter((n) => !failed.includes(n) && !skipped.includes(n));
    if (stillDown.length > 0) {
      this.log.error(`${label}: services are down after the restart: ${stillDown.join(', ')}`);
      this.runner.emit(run, `down after the restart: ${stillDown.join(', ')}\n`);
    }
    for (const line of detail) this.runner.emit(run, `  ${line}\n`);
    if (failed.length === 0 && skipped.length === 0 && down.length === 0) return false;
    this.runner.finalize(run, 1);
    return true;
  }

  // Names grouped so that no level holds a process depending on one in a later level. A dependency
  // outside `names` cannot be ordered here — the caller's scope check owns that case.
  private restartLevels(names: string[], graph: Record<string, string[]>): string[][] {
    const pending = new Set(names);
    const levels: string[][] = [];
    while (pending.size > 0) {
      const free = [...pending].filter((n) => !(graph[n] ?? []).some((d) => pending.has(d)));
      // a dependency cycle frees nothing — take the rest rather than spin
      const level = free.length > 0 ? free : [...pending];
      for (const n of level) pending.delete(n);
      levels.push(level);
    }
    return levels;
  }

  // Level by level and gated on procIsDepReady: a process restarted before its dependency is Ready
  // is left Skipped for good. A failure blocks only its own dependents; the rest still restart.
  private async restartAll(
    names: string[],
    graph: Record<string, string[]>,
    onEach?: (name: string, outcome: RestartOutcome) => void,
  ): Promise<{ failed: string[]; skipped: string[] }> {
    const levels = this.restartLevels(names, graph);
    const failed: string[] = [];
    const skipped: string[] = [];
    const blocked = new Set<string>();
    for (const level of levels) {
      const attempt = level.filter((name) => {
        // a dependency outside `names` never blocks here — the caller's scope check owns that case
        if (!(graph[name] ?? []).some((d) => blocked.has(d))) return true;
        onEach?.(name, 'skipped');
        skipped.push(name);
        blocked.add(name);
        return false;
      });
      // restartAndWait, not restart: POST /process/restart can 200 without starting the process
      const outcomes = await Promise.allSettled(
        attempt.map(async (name) => {
          const ok = (await this.pc.restartAndWait(name)) && (await this.pc.waitUntilDepReady(name));
          onEach?.(name, ok ? 'restarted' : 'failed');
          return ok;
        }),
      );
      attempt.forEach((name, j) => {
        const outcome = outcomes[j];
        if (outcome.status === 'rejected' || outcome.value === false) {
          failed.push(name);
          blocked.add(name);
        }
      });
    }
    return { failed, skipped };
  }

  /** A process left Skipped by the recreate cannot be revived by restarting it — only a dependency
   *  transition clears it, so hand the residue to the reconcile ladder that already does that. */
  private async recoverWedged(
    run: RunState,
    names: string[],
    graph: Record<string, string[]>,
    first: { failed: string[]; skipped: string[] },
  ): Promise<{ failed: string[]; skipped: string[] }> {
    const stuck = new Set([...first.failed, ...first.skipped]);
    if (stuck.size === 0) return first;
    const wedged = (await this.verifyUp(names, graph)).down.filter((n) => stuck.has(n));
    // nothing this restart reported is actually down — report what was measured, do not clear it
    if (wedged.length === 0) return first;
    this.runner.emit(run, `reconciling ${wedged.join(', ')}\n`);
    const code = await this.runner.spawn(run, 'stack-reconcile', []);
    if (code !== 0) {
      this.log.warn(`reload recovery: stack-reconcile exited ${code}`);
      this.runner.emit(run, `reconcile exited ${code} — the verdict below is what the processes report\n`);
    }
    const stillDown = (await this.verifyUp(names, graph)).down.filter((n) => stuck.has(n));
    if (stillDown.length > 0) return { failed: stillDown, skipped: [] };
    this.runner.emit(run, `recovered ${wedged.join(', ')}\n`);
    return { failed: [], skipped: [] };
  }

  private async applyOverlayAndRestart(run: RunState): Promise<void> {
    this.runner.emit(run, 'applying overlay\n');
    try {
      await this.rendered.applyOverlay();
    } catch (e) {
      const msg = getErrorMessage(e);
      this.log.error(`redeploy: overlay regenerate/apply failed: ${msg}`);
      this.runner.emit(run, `overlay regenerate/apply failed: ${msg}\n`);
      this.runner.finalize(run, 1);
      return;
    }
    // cancelRun force-finalizes runs it cannot signal — stop at phase boundaries instead of restarting behind a cancelled run.
    if (run.status !== 'running') return;
    try {
      const procs = await this.pc.list();
      const catalog = await this.rendered.catalog();
      const graph = await this.rendered.dependsGraph();
      const targets = procs
        .filter((p) => isRollableService(resolveCatalog(p.name, catalog)?.entry.namespace ?? ''))
        .map((p) => p.name);
      if (run.status !== 'running') return;
      this.runner.emit(run, `restarting ${targets.length} service${targets.length === 1 ? '' : 's'}\n`);
      const { failed, skipped } = await this.restartAll(targets, graph, (name, outcome) =>
        this.runner.emit(run, `  ${name} ${RESTART_LINE[outcome]}\n`),
      );
      if (await this.failIfNotUp(run, 'redeploy', targets, graph, failed, skipped)) return;
      this.overlay.clearSatisfiedBy('redeploy');
      this.runner.finalize(run, 0);
    } catch (e) {
      const msg = getErrorMessage(e);
      this.log.error(`redeploy: roster restart failed: ${msg}`);
      this.runner.emit(run, `roster restart failed: ${msg}\n`);
      this.runner.finalize(run, 1);
    }
  }
}
