import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '../common/errors';
import { RunnerService, type RunState } from '../runner/runner.service';
import { readAppliedMode } from './applied-manifest';
import { OverlayStoreService } from './overlay-store';
import { classifyProc, depsReady, ProcessComposeClient, procIsUp, type PcProcess } from './process-compose.client';
import { isRollableService, RenderedConfigService, resolveCatalog } from './rendered-config.service';
import { OBSERVABILITY_PROCS, type StackGroup } from './stack-knobs';
import { StackRestartService } from './stack-restart.service';

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

  private failIfModeChangePending(run: RunState, reason: string): boolean {
    if (this.overlay.fleetMode() === readAppliedMode()) return false;
    this.log.warn(reason);
    this.runner.emit(run, `${reason}\n`);
    this.runner.finalize(run, 1);
    return true;
  }

  private async orchestrateRedeploy(run: RunState): Promise<void> {
    if (
      this.failIfModeChangePending(
        run,
        'redeploy blocked: a fleet-mode change is pending — apply it via Fleet → Apply (fleet-mode-apply) first',
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
      this.failIfModeChangePending(
        run,
        `reload ${group} blocked: a fleet-mode change is pending — apply it via Fleet → Apply (fleet-mode-apply) first`,
      )
    )
      return;
    this.runner.emit(run, 'applying overlay\n');
    try {
      await this.rendered.applyOverlay();
    } catch (e) {
      const msg = getErrorMessage(e);
      this.log.error(`reload ${group}: overlay regenerate/apply failed: ${msg}`);
      this.runner.emit(run, `overlay regenerate/apply failed: ${msg}\n`);
      this.runner.finalize(run, 1);
      return;
    }
    if (run.status !== 'running') return;
    try {
      const names = await this.groupProcs(group);
      if (run.status !== 'running') return;
      this.runner.emit(run, `restarting ${names.length} service${names.length === 1 ? '' : 's'}\n`);
      await Promise.all(names.map((n) => this.pc.restart(n)));
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
      await this.rendered.applyOverlay();
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
        await Promise.all(reloadable.map((n) => this.pc.restart(n)));
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
      const targets = procs
        .filter((p) => isRollableService(resolveCatalog(p.name, catalog)?.entry.namespace ?? ''))
        .map((p) => p.name);
      if (run.status !== 'running') return;
      this.runner.emit(run, `restarting ${targets.length} service${targets.length === 1 ? '' : 's'}\n`);
      await Promise.all(targets.map((name) => this.pc.restart(name)));
      this.runner.finalize(run, 0);
    } catch (e) {
      const msg = getErrorMessage(e);
      this.log.error(`redeploy: roster restart failed: ${msg}`);
      this.runner.emit(run, `roster restart failed: ${msg}\n`);
      this.runner.finalize(run, 1);
    }
  }
}
