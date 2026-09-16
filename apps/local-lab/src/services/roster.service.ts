import { Injectable, Logger } from '@nestjs/common';

import type { AppLink, Service } from '../contract';
import { PORTS } from '../ports';
import { OverlayStoreService, type LabBridge } from './overlay-store';
import {
  classifyProc,
  depsReady,
  ProcessComposeClient,
  procIsUp,
  type PcProcess,
  type ProcDiag,
} from './process-compose.client';
import { isServiceNamespace, RenderedConfigService, resolveCatalog } from './rendered-config.service';

const REPLICA_STEP: Record<string, number> = { 'hub-api': PORTS.hubApi.step };

const ROSTER_REUSE_MS = 30_000;

const bridgeLabel = (b: LabBridge): string => (b.replica === 0 ? 'Bridge' : `Bridge ${b.replica}`);

const svcHealth = (d: ProcDiag): Pick<Service, 'health' | 'restarts' | 'exitCode' | 'detail'> => ({
  health: d.status,
  restarts: d.restarts,
  exitCode: d.exitCode,
  detail: d.detail,
});

// gated on running so a stopped process never surfaces a leftover sample as live load.
const svcTelemetry = (p: PcProcess, running: boolean): Pick<Service, 'cpuPct' | 'memBytes' | 'age'> =>
  running
    ? {
        cpuPct: typeof p.cpu === 'number' ? p.cpu : undefined,
        memBytes: typeof p.mem === 'number' ? p.mem : undefined,
        age: typeof p.system_time === 'string' ? p.system_time : undefined,
      }
    : {};

@Injectable()
export class RosterService {
  private readonly log = new Logger(RosterService.name);

  // app-link ids already warned about for an unresolvable (0) port, so a misconfigured marker doesn't
  // re-log on every status poll.
  private readonly warnedBadPortApps = new Set<string>();

  private lastProcs: { procs: PcProcess[]; at: number } | null = null;

  constructor(
    private readonly pc: ProcessComposeClient,
    private readonly rendered: RenderedConfigService,
    private readonly overlay: OverlayStoreService,
  ) {}

  async list(): Promise<Service[]> {
    let procs: PcProcess[];
    try {
      procs = await this.pc.listAll();
    } catch {
      return await this.defs();
    }
    const byProc = new Map(this.overlay.labBridges().map((b) => [b.proc, b]));
    const byName = new Map(procs.map((p) => [p.name, p]));
    const graph = await this.rendered.dependsGraph();
    const catalog = await this.rendered.catalogOrEmpty();
    const out: Service[] = [];
    for (const p of procs) {
      const running = (p.status ?? '').toLowerCase() === 'running';
      const ready = running && (p.is_ready ?? '').toLowerCase() === 'ready';
      const pid = running && typeof p.pid === 'number' && p.pid > 0 ? p.pid : null;
      const health = svcHealth(classifyProc(p, depsReady(p.name, byName, graph)));
      const bridge = byProc.get(p.name);
      if (bridge) {
        out.push({
          id: p.name,
          label: bridgeLabel(bridge),
          group: 'spoke',
          zone: bridge.zone,
          port: bridge.port,
          running,
          ready,
          pid,
          ...health,
          ...svcTelemetry(p, running),
          canStop: true,
          features: resolveCatalog(p.name, catalog)?.entry.features,
        });
        continue;
      }
      const r = resolveCatalog(p.name, catalog);
      if (!r || !isServiceNamespace(r.entry.namespace)) continue;
      const telegrafZone = p.name.endsWith('-telegraf')
        ? (byProc.get(p.name.slice(0, -'-telegraf'.length))?.zone ?? null)
        : null;
      out.push({
        id: p.name,
        label: r.replica === 0 ? r.entry.label : `${r.entry.label} ${r.replica}`,
        group: r.entry.namespace,
        zone: telegrafZone,
        port: (r.entry.port ?? 0) + r.replica * (REPLICA_STEP[r.base] ?? 0),
        running,
        ready,
        pid,
        ...health,
        ...svcTelemetry(p, running),
        canStop: r.entry.namespace !== 'control',
        features: r.entry.features,
      });
    }
    return out.sort((a, b) => a.port - b.port);
  }

  async defs(): Promise<Service[]> {
    const catalog = await this.rendered.catalogOrEmpty();
    const out: Service[] = [];
    const mk = (id: string, label: string, ns: string, port: number, features?: string[]): Service => ({
      id,
      label,
      group: ns,
      zone: null,
      port,
      running: false,
      ready: false,
      pid: null,
      health: 'missing',
      canStop: ns !== 'control',
      features,
    });
    const roster = this.overlay.labBridges();
    const rosterProcs = new Set(roster.map((b) => b.proc));
    for (const [name, c] of catalog) {
      if (!isServiceNamespace(c.namespace)) continue;
      // bridge rows come from the labBridges roster (skip their catalog twins); non-bridge spoke
      // processes (telegraf, spoke-watch) and — with no roster — the catalog's own rows stand in.
      if (rosterProcs.has(name)) continue;
      out.push(mk(name, c.label, c.namespace, c.port ?? 0, c.features));
    }
    for (const b of roster)
      out.push(mk(b.proc, bridgeLabel(b), 'spoke', b.port, resolveCatalog(b.proc, catalog)?.entry.features));
    return out.sort((a, b) => a.port - b.port);
  }

  /** A saturated host drops single process-compose calls; reuse a recent roster so one dropped call
   *  can't grey out every app link, and only report nothing-ready once that roster goes stale. */
  private async procsOrRecent(): Promise<PcProcess[] | null> {
    try {
      const procs = await this.pc.listAll();
      this.lastProcs = { procs, at: Date.now() };
      return procs;
    } catch {
      const recent = this.lastProcs;
      return recent && Date.now() - recent.at < ROSTER_REUSE_MS ? recent.procs : null;
    }
  }

  /** Sidebar Apps web-UI links from the catalog's LAB_WEB_UI markers. With no roster at all, degrade to
   *  the catalog alone (every UI listed not-ready) rather than blanking the sidebar — mirrors defs(). */
  async listAppLinks(): Promise<AppLink[]> {
    const [catalog, procs] = await Promise.all([this.rendered.catalogOrEmpty(), this.procsOrRecent()]);
    const byName = procs ? new Map(procs.map((p) => [p.name, p])) : null;
    const links: AppLink[] = [];
    for (const [id, entry] of catalog) {
      if (!entry.webUi || entry.disabled) continue;
      const p = byName?.get(id);
      // With a live roster, a UI absent from it or sitting Disabled is omitted; without one (server
      // unreachable) fall through and list it as not-ready.
      if (byName && (!p || (p.status ?? '').toLowerCase() === 'disabled')) continue;
      // Drop a UI whose resolved port isn't a valid TCP port (1–65535) rather than render a dead link
      // or leak it past AppLinkSchema's range bound.
      const uiPort = entry.webUi.port;
      if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) {
        if (!this.warnedBadPortApps.has(id)) {
          this.warnedBadPortApps.add(id);
          this.log.warn(`app "${id}" is marked LAB_WEB_UI but has no valid port (${uiPort}) — omitting its link`);
        }
        continue;
      }
      links.push({
        id,
        label: entry.webUi.label,
        path: entry.webUi.path,
        port: entry.webUi.port,
        ready: procIsUp(p),
        loopback: entry.webUi.loopback,
      });
    }
    return links.sort((a, b) => a.port - b.port);
  }
}
