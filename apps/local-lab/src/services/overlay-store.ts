import { ConflictException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getErrorMessage } from '../common/errors';
import { resolveIfaceIp } from '../common/net';
import { DevenvSeedEvalSchema, parseBoundary } from '../common/pc-schemas';
import type { StackKnob } from '../contract';
import { HOSTS, mkPgUrl, STACK_SLOT } from '../ports';
import { devenvRoot } from './paths';
import { RenderedConfigService } from './rendered-config.service';
import {
  editablePortsFrom,
  emptyStackDefaults,
  OBSERVABILITY_PORT_KEYS,
  observabilityPortsFrom,
  resolvedKnobs,
  servicePortRows,
  STACK_KNOBS,
  STACK_PORTS,
  type StackDefaults,
  type StackGroup,
} from './stack-knobs';
import { StackRegistryClient } from './stack-registry-client';

const execFileP = promisify(execFile);

type ZoneMeta = { name: string; index: number; bridges: number };
/** Every bridge process across every zone, from `devenv eval labBridges` — the naming and per-zone port
 *  math live in modules/spoke.nix, so nothing here re-derives them. */
export type LabBridge = { proc: string; zone: string; replica: number; port: number; grpc: number };

/** Service identity overridable via stack.local.nix; the eval reports the effective values. */
type IdentityCfg = { pg: { user: string; password: string; db: string }; orgId: string };
type OsLayerCfg = { originHost: string; resolvers: string };
type LanCfg = { expose: boolean };
type TelemetryCfg = { enable: boolean };

/** What an unseeded mirror knows about the config: nothing. Blank beats a plausible-looking guess at
 *  Nix's defaults, and writes are refused until a seed succeeds anyway. */
const UNSEEDED_IDENTITY: IdentityCfg = { pg: { user: '', password: '', db: '' }, orgId: '' };
// ASSET_ORIGIN is the lab's own process env (modules/ports.nix mkLabPortEnv), not a copy of a Nix default.
const UNSEEDED_OSLAYER: OsLayerCfg = { originHost: HOSTS.assetOrigin, resolvers: '' };

export type FleetMirror = {
  network: Record<string, unknown>;
  defaults: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
};

export type BareMetalMirror = {
  nics: string[];
  arch: string;
  nodes: Record<string, Record<string, unknown>>;
};

type FleetEvalNode = Record<string, unknown> & { enable?: boolean; index?: number };
type FleetEvalZone = { index?: number; bridges?: number; nodes?: Record<string, FleetEvalNode> };
type FleetEvalBareMetal = {
  iface?: string;
  nics?: string[];
  arch?: string;
  nodes?: Record<string, FleetEvalNode>;
};
type FleetEval = {
  network?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  nodes?: Record<string, FleetEvalNode>;
  zones?: Record<string, FleetEvalZone>;
  mode?: string;
  baremetal?: FleetEvalBareMetal;
};

/** Must match modules/fleet-topology.nix's global node ordering. */
function flattenFleetNodes(fleet: FleetEval): Record<string, FleetEvalNode> {
  const zones = fleet.zones;
  if (!zones || Object.keys(zones).length === 0) return fleet.nodes ?? {};
  const byZoneIndex = Object.entries(zones).sort(([, a], [, b]) => (a.index ?? 0) - (b.index ?? 0));
  const flat: Record<string, FleetEvalNode> = {};
  let ordinal = 0;
  for (const [zoneName, zone] of byZoneIndex) {
    const byNodeIndex = Object.entries(zone.nodes ?? {}).sort(([, a], [, b]) => (a.index ?? 0) - (b.index ?? 0));
    for (const [nodeName, node] of byNodeIndex) {
      flat[nodeName] = { ...node, zone: zoneName, index: ordinal++ };
    }
  }
  return flat;
}

/** `seeded`: the devenv eval succeeded, so this reflects the live config and not bare defaults — writes are refused otherwise.
 *  `fleetOwned`: fleet is only re-emitted on write when the overlay declares one — editing stack config alone must never pin the committed base fleet. */
type Mirror = {
  seeded: boolean;
  hub: Record<string, string>;
  spoke: Record<string, string>;
  counts: { hub: number; spoke: number };
  slot: number;
  slotOwned: boolean;
  identity: IdentityCfg;
  osLayerCache: OsLayerCfg;
  lan: LanCfg;
  telemetry: TelemetryCfg;
  stackDefaults: StackDefaults;
  portKeys: { editable: string[]; readOnly: string[] };
  ports: Record<string, number>;
  /** Pre-override value of each editable port (`devenv eval portDefaults`) — what `ports` is diffed
   *  against to decide which keys the overlay must pin. */
  portDefaults: Record<string, number>;
  observabilityPorts: Record<string, number>;
  bridges: LabBridge[];
  fleet: FleetMirror | null;
  fleetOwned: boolean;
  mode: 'vm' | 'baremetal';
  baremetal: BareMetalMirror | null;
  baremetalOwned: boolean;
  zonesMeta: ZoneMeta[];
};

/** Hub is pinned to 1: modules/hub.nix probes every replica on the base port, so a replica beyond the
 *  first reports the primary's health and nothing in Nix consumes stackCounts to start one anyway. */
const MAX_HUBS = 1;
const MAX_SPOKES = 8;

const clampCount = (v: unknown, max: number): number => {
  const x = Number(v);
  return Number.isInteger(x) && x >= 1 ? Math.min(x, max) : 1;
};

const isPortOverride = (key: string, value: number, defaults: Record<string, number>): boolean =>
  defaults[key] !== value;

// ServiceSchema's port is a plain z.number(), which rejects NaN — never let one out of the eval boundary.
const nonNegativeInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

function emptyMirror(): Mirror {
  return {
    seeded: false,
    hub: {},
    spoke: {},
    counts: { hub: 1, spoke: 1 },
    slot: STACK_SLOT,
    slotOwned: false,
    identity: UNSEEDED_IDENTITY,
    osLayerCache: UNSEEDED_OSLAYER,
    lan: { expose: false },
    telemetry: { enable: false },
    stackDefaults: emptyStackDefaults(),
    portKeys: { editable: [], readOnly: [] },
    ports: {},
    portDefaults: {},
    observabilityPorts: {},
    bridges: [],
    fleet: null,
    fleetOwned: false,
    mode: 'vm',
    baremetal: null,
    baremetalOwned: false,
    zonesMeta: [],
  };
}

@Injectable()
export class OverlayStoreService implements OnModuleInit {
  private readonly log = new Logger(OverlayStoreService.name);

  private readonly devenvRoot = devenvRoot();

  private mirror: Mirror | null = null;

  private seedInFlight: Promise<void> | null = null;

  private rebindPending = false;

  private rebindReason = 'datastore/LAN bind changed';

  private rebindWipe: import('./restart-marker').RestartWipe | undefined = undefined;

  private telemetryHook?: () => void;

  constructor(
    private readonly rendered: RenderedConfigService,
    private readonly registry: StackRegistryClient = new StackRegistryClient(),
  ) {}

  onModuleInit(): void {
    this.warnOnAbandonedOverlay();
    void this.reseed();
  }

  /** Re-runs the seed eval so a boot-time devenv failure isn't permanent; concurrent callers share the run. */
  reseed(): Promise<void> {
    this.seedInFlight ??= this.seedMirror().finally(() => {
      this.seedInFlight = null;
    });
    return this.seedInFlight;
  }

  isRebindPending(): boolean {
    return this.rebindPending;
  }

  armRebindPending(reason?: string, wipe?: import('./restart-marker').RestartWipe): void {
    this.rebindPending = true;
    if (reason) this.rebindReason = reason;
    if (wipe !== undefined) this.rebindWipe = wipe;
  }

  rebindReasonText(): string {
    return this.rebindReason;
  }

  rebindWipeKind(): import('./restart-marker').RestartWipe | undefined {
    return this.rebindWipe;
  }

  clearRebindPending(): void {
    this.rebindPending = false;
    this.rebindWipe = undefined;
  }

  slot(): number {
    return this.current().slot;
  }

  registerTelemetryApplyHook(hook: () => void): void {
    // RedeployService registers this at construction; a DI edge back would re-create the overlay↔redeploy cycle.
    this.telemetryHook = hook;
  }

  telemetryEnabled(): boolean {
    return this.current().telemetry.enable;
  }

  labBridges(): LabBridge[] {
    return this.current().bridges;
  }

  private async seedMirror(): Promise<void> {
    try {
      const { stdout } = await execFileP(
        'devenv',
        [
          'eval',
          'stack.slot',
          'stackOverrides',
          'stackCounts',
          'stackDefaults',
          'portGroups',
          'labBridges',
          'identity',
          'osLayerCache',
          'lan',
          'telemetry',
          'ports',
          'portDefaults',
          'fleet',
        ],
        {
          cwd: this.devenvRoot,
          timeout: 120_000,
        },
      );
      const j = parseBoundary(DevenvSeedEvalSchema, JSON.parse(stdout), 'devenv seed eval');
      const so = j.stackOverrides ?? {};
      const sc = j.stackCounts ?? {};
      const identity: IdentityCfg = {
        pg: {
          user: j.identity?.pg?.user ?? '',
          password: j.identity?.pg?.password ?? '',
          db: j.identity?.pg?.db ?? '',
        },
        orgId: j.identity?.orgId ?? '',
      };
      const osLayerCache: OsLayerCfg = {
        originHost: j.osLayerCache?.originHost ?? HOSTS.assetOrigin,
        resolvers: j.osLayerCache?.resolvers ?? '',
      };
      const lan: LanCfg = { expose: j.lan?.expose ?? false };
      const telemetry: TelemetryCfg = { enable: j.telemetry?.enable ?? false };
      const stackDefaults: StackDefaults = {
        hub: j.stackDefaults?.hub ?? {},
        spoke: j.stackDefaults?.spoke ?? {},
        hubKnobEnv: j.stackDefaults?.hubKnobEnv ?? {},
      };
      const portKeys = { editable: j.portGroups?.editable ?? [], readOnly: j.portGroups?.readOnly ?? [] };
      const ports = editablePortsFrom(j.ports, portKeys.editable);
      const portDefaults = editablePortsFrom(j.portDefaults, portKeys.editable);
      const observabilityPorts = observabilityPortsFrom(j.ports, portKeys.readOnly);
      const bridges: LabBridge[] = (j.labBridges ?? []).flatMap((b) =>
        b.proc
          ? [
              {
                proc: b.proc,
                zone: b.zone ?? '',
                replica: nonNegativeInt(b.replica),
                port: nonNegativeInt(b.port),
                grpc: nonNegativeInt(b.grpc),
              },
            ]
          : [],
      );
      const fleet: FleetMirror | null = j.fleet
        ? { network: j.fleet.network ?? {}, defaults: j.fleet.defaults ?? {}, nodes: flattenFleetNodes(j.fleet) }
        : null;
      const mode: 'vm' | 'baremetal' = j.fleet?.mode === 'baremetal' ? 'baremetal' : 'vm';
      const bm = j.fleet?.baremetal;
      const baremetal: BareMetalMirror | null = bm
        ? {
            nics: Array.isArray(bm.nics) ? bm.nics : bm.iface ? [bm.iface] : [],
            arch: typeof bm.arch === 'string' ? bm.arch : 'amd64',
            nodes: Object.fromEntries(
              Object.entries(bm.nodes ?? {})
                .filter(([, n]) => n.enable !== false)
                .map(([name, n]) => {
                  const { enable, index, ...spec } = n;
                  void enable;
                  void index;
                  return [name, spec];
                }),
            ),
          }
        : null;
      const zonesMeta: ZoneMeta[] = j.fleet?.zones
        ? Object.entries(j.fleet.zones).map(([name, z]) => ({
            name,
            index: z.index ?? 0,
            bridges: Math.max(1, Number(z.bridges ?? 1)),
          }))
        : [];
      this.mirror = {
        seeded: true,
        hub: so.hub ?? {},
        spoke: so.spoke ?? {},
        counts: { hub: clampCount(sc.hub, MAX_HUBS), spoke: clampCount(sc.spoke, MAX_SPOKES) },
        slot: j['stack.slot'] ?? STACK_SLOT,
        slotOwned: this.overlayHasSlot(),
        identity,
        osLayerCache,
        lan,
        telemetry,
        stackDefaults,
        portKeys,
        ports,
        portDefaults,
        observabilityPorts,
        bridges,
        fleet,
        fleetOwned: this.overlayHasFleet(),
        mode,
        baremetal,
        baremetalOwned: this.overlayHasBaremetal(),
        zonesMeta,
      };
      this.log.log(
        `seeded stack overrides (hub=${Object.keys(this.mirror.hub).length} spoke=${Object.keys(this.mirror.spoke).length} knobs; pg user=${identity.pg.user}; bridges=${bridges.length}; fleet nodes=${Object.keys(fleet?.nodes ?? {}).length})`,
      );
    } catch (e) {
      // an earlier success keeps its values for reads, but fleetOwned/baremetalOwned were derived from
      // a disk read at that time — writing from a stale pair can drop an overlay block the file now has
      if (this.mirror) this.mirror = { ...this.mirror, seeded: false };
      this.log.warn(
        `devenv eval stackOverrides failed; serving the last mirror, writes refused: ${getErrorMessage(e)}`,
      );
    }
  }

  originHost(): string {
    return this.current().osLayerCache.originHost;
  }

  private current(): Mirror {
    return this.mirror ?? emptyMirror();
  }

  /** Writes rebuild stack.local.nix from the mirror alone, so an unseeded one would erase the fleet
   *  topology and port overrides already in the file. Kicks off a retry so a later save can succeed. */
  private writableMirror(): Mirror {
    const m = this.current();
    if (!m.seeded) {
      void this.reseed();
      throw new ServiceUnavailableException(
        'stack overlay state is unknown — the devenv eval seed failed, and saving now would wipe the fleet topology and port overrides in stack.local.nix. Fix the devenv eval and retry.',
      );
    }
    return m;
  }

  private overlayPath(): string {
    return join(this.devenvRoot, 'stack.local.nix');
  }

  /** Before the root was corrected, a standalone lab wrote the overlay a level down, where devenv never
   *  read it. Copying it up would silently activate settings that never applied, so only warn. */
  private warnOnAbandonedOverlay(): void {
    const abandoned = join(this.devenvRoot, 'devenv', 'stack.local.nix');
    if (!existsSync(abandoned)) return;
    this.log.warn(
      `ignoring a stale overlay at ${abandoned} — devenv never evaluated it; copy it onto ${this.overlayPath()} to adopt those settings`,
    );
  }

  /** Enumerates the topology keys rather than any `fleet.*`: a stale `fleet.mode` line (or a hand-written one)
   *  is not a topology declaration, and matching it would let a plain stack save claim the committed base fleet. */
  private overlayHasFleet(): boolean {
    try {
      return (
        existsSync(this.overlayPath()) &&
        /(^|\n)\s*fleet\.(zones|nodes|defaults|baremetal)\b/.test(readFileSync(this.overlayPath(), 'utf8'))
      );
    } catch {
      return false;
    }
  }

  private overlayHasBaremetal(): boolean {
    try {
      return (
        existsSync(this.overlayPath()) && /(^|\n)\s*fleet\.baremetal/.test(readFileSync(this.overlayPath(), 'utf8'))
      );
    } catch {
      return false;
    }
  }

  private overlayHasSlot(): boolean {
    try {
      return existsSync(this.overlayPath()) && /(^|\n)\s*stack\.slot\b/.test(readFileSync(this.overlayPath(), 'utf8'));
    } catch {
      return false;
    }
  }

  fleetConfig(): FleetMirror | null {
    return this.current().fleet;
  }

  fleetCustomized(): boolean {
    return this.current().fleetOwned;
  }

  fleetMode(): 'vm' | 'baremetal' {
    return this.current().mode;
  }

  baremetalConfig(): BareMetalMirror | null {
    return this.current().baremetal;
  }

  fleetZones(): string[] {
    const cur = this.current();
    const byIndex = [...cur.zonesMeta].sort((a, b) => a.index - b.index).map((z) => z.name);
    if (byIndex.length > 0) return byIndex;
    const fromNodes = [
      ...new Set(
        Object.values(cur.fleet?.nodes ?? {})
          .map((n) => (n as { zone?: unknown }).zone)
          .filter((z): z is string => typeof z === 'string' && !!z),
      ),
    ];
    return fromNodes.length > 0 ? fromNodes : ['sim-zone'];
  }

  private overrides(): {
    hub: Record<string, string>;
    spoke: Record<string, string>;
  } {
    const { hub, spoke } = this.current();
    return { hub, spoke };
  }

  counts(): { hub: number; spoke: number } {
    return this.current().counts;
  }

  /** The panel polls this while unseeded, so the read is the only recovery trigger a blocked save leaves —
   *  reseed() is single-flight and a later poll observes the recovered mirror. */
  stackConfig() {
    const cur = this.current();
    if (!cur.seeded) void this.reseed();
    const { seeded, identity, osLayerCache, lan, telemetry, stackDefaults, portKeys, ports, observabilityPorts } = cur;
    const originHost = osLayerCache.originHost;
    // `derived` knobs: the eval's copy lags an unrebuilt identity/origin edit that is already in the mirror.
    const fillDynamic = (k: StackKnob): StackKnob => {
      if (k.env === 'HUB_REPO_PATH') return { ...k, default: process.env.HUB_REPO_PATH ?? k.default };
      if (k.env === 'DATABASE_URL' && identity.pg.user && identity.pg.db) {
        return { ...k, default: mkPgUrl(identity.pg, ports.postgres) };
      }
      if (k.env === 'DISCOVERY_BASE_URL' && originHost) {
        return { ...k, default: `https://${originHost}/brokkr-live-light` };
      }
      return k;
    };
    return {
      seeded,
      slot: cur.slot,
      knobs: {
        hub: resolvedKnobs('hub', stackDefaults).map(fillDynamic),
        spoke: resolvedKnobs('spoke', stackDefaults).map(fillDynamic),
      },
      ports: STACK_PORTS,
      servicePorts: [
        ...servicePortRows(portKeys.editable, ports, false),
        ...servicePortRows(OBSERVABILITY_PORT_KEYS, observabilityPorts, true),
      ],
      values: this.overrides(),
      counts: this.counts(),
      identity,
      osLayerCache,
      lan,
      telemetry,
    };
  }

  async setStackConfig(cfg: {
    hub: Record<string, string>;
    spoke: Record<string, string>;
    counts?: { hub?: number; spoke?: number };
    identity?: { pg?: Partial<IdentityCfg['pg']>; orgId?: string };
    osLayerCache?: Partial<OsLayerCfg>;
    lan?: Partial<LanCfg>;
    telemetry?: Partial<TelemetryCfg>;
    ports?: Record<string, number>;
    slot?: number;
  }): Promise<{ applied: string[]; rejected: string[] }> {
    const applied: string[] = [];
    const rejected: string[] = [];
    // a slot move rebases the mirror (fleet/port pins would outrank the new slot's derived defaults), so a
    // ports object riding the same save is deliberately dropped — the operator was told pins reset.
    let slotChanged = false;
    if (cfg.slot !== undefined && cfg.slot !== this.current().slot) {
      await this.setStackSlot(cfg.slot);
      applied.push('stack.slot');
      slotChanged = true;
    }
    const cur = this.writableMirror();
    const clean = (svc: StackGroup) => {
      const known = new Set(STACK_KNOBS[svc].map((k) => k.env));
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg[svc] ?? {})) {
        if (!known.has(k)) rejected.push(`${svc}.${k}`);
        else if (v?.trim()) {
          out[k] = v.trim();
          applied.push(`${svc}.${k}`);
        }
      }
      return out;
    };
    // a blank identity/cache field keeps the effective value: unlike the ports below, these have no
    // published pre-override map to reset to.
    const pick = (v: string | undefined, d: string) => (v?.trim() ? v.trim() : d);
    const identity: IdentityCfg = {
      pg: {
        user: pick(cfg.identity?.pg?.user, cur.identity.pg.user),
        password: pick(cfg.identity?.pg?.password, cur.identity.pg.password),
        db: pick(cfg.identity?.pg?.db, cur.identity.pg.db),
      },
      orgId: pick(cfg.identity?.orgId, cur.identity.orgId),
    };
    const osLayerCache: OsLayerCfg = {
      originHost: pick(cfg.osLayerCache?.originHost, cur.osLayerCache.originHost),
      resolvers: pick(cfg.osLayerCache?.resolvers, cur.osLayerCache.resolvers),
    };
    // a key the payload omits reverts to its Nix default — the editor drops a blank or out-of-range field,
    // so blanking one is how an operator un-pins a port. An absent `ports` object edits no port at all.
    const ports = slotChanged
      ? cur.ports
      : cfg.ports
        ? editablePortsFrom(cfg.ports, cur.portKeys.editable, cur.portDefaults)
        : cur.ports;
    // unknown/read-only keys are absent from editablePortsFrom's output (ports[k] undefined) and out-of-range
    // values revert to the Nix default — either way ports[k] !== v. An accepted default writes no override.
    for (const [k, v] of Object.entries(slotChanged ? {} : (cfg.ports ?? {}))) {
      if (ports[k] !== v) rejected.push(`ports.${k}`);
      else if (isPortOverride(k, v, cur.portDefaults)) applied.push(`ports.${k}`);
    }
    const lan: LanCfg = { expose: cfg.lan?.expose ?? cur.lan.expose };
    const telemetry: TelemetryCfg = { enable: cfg.telemetry?.enable ?? cur.telemetry.enable };
    const telemetryChanged = telemetry.enable !== cur.telemetry.enable;
    const hub = clean('hub');
    const spoke = clean('spoke');
    const counts = { hub: clampCount(cfg.counts?.hub, MAX_HUBS), spoke: clampCount(cfg.counts?.spoke, MAX_SPOKES) };
    // The LAN toggle changes the same frozen listener binds as the ports, so it latches the daemon recreate too.
    if (JSON.stringify(ports) !== JSON.stringify(cur.ports) || lan.expose !== cur.lan.expose) {
      this.armRebindPending();
    }
    this.mirror = {
      seeded: true,
      hub,
      spoke,
      counts,
      slot: cur.slot,
      slotOwned: cur.slotOwned,
      identity,
      osLayerCache,
      lan,
      telemetry,
      stackDefaults: cur.stackDefaults,
      portKeys: cur.portKeys,
      ports,
      portDefaults: cur.portDefaults,
      observabilityPorts: cur.observabilityPorts,
      bridges: cur.bridges,
      fleet: cur.fleet,
      fleetOwned: cur.fleetOwned,
      mode: cur.mode,
      baremetal: cur.baremetal,
      baremetalOwned: cur.baremetalOwned,
      zonesMeta: cur.zonesMeta,
    };
    this.writeOverlay();
    const portOverrides = Object.entries(ports).filter(([k, v]) => isPortOverride(k, v, cur.portDefaults)).length;
    this.log.log(
      `wrote stack.local.nix (hubs=${counts.hub} spokes=${counts.spoke}; pg user=${identity.pg.user}; port overrides=${portOverrides}; lan.expose=${lan.expose}; telemetry.enable=${telemetry.enable})`,
    );
    if (telemetryChanged) {
      if (this.telemetryHook) this.telemetryHook();
      else this.log.warn('telemetry changed but no apply hook is registered — skipping apply');
    }
    return { applied: applied.sort(), rejected: rejected.sort() };
  }

  /** Moves the stack to slot `n`: plain-priority fleet/port pins would outrank the new slot's derived
   *  defaults, so the mirror is rebased (both dropped) and the recreation is armed via the rebind latch. */
  async setStackSlot(n: number): Promise<void> {
    const cur = this.writableMirror();
    if (n === cur.slot) return;
    const owner = await this.registry.ownerOfSlot(n);
    if (owner) throw new ConflictException(`slot ${n} already claimed by ${owner}`);
    this.mirror = { ...cur, slot: n, slotOwned: true, fleetOwned: false, baremetalOwned: false, ports: {} };
    this.writeOverlay();
    this.armRebindPending('slot change', 'stack-reslot');
    this.log.log(`wrote stack.local.nix (stack.slot=${n}; fleet + port overrides rebased to the slot's defaults)`);
  }

  setFleetConfig(input: {
    nodes: { name: string; spec: Record<string, unknown> }[];
    bmcDefaults?: { username: string; password: string };
    mode?: 'vm' | 'baremetal';
    baremetal?: { nics: string[]; arch: string; nodes: { name: string; spec: Record<string, unknown> }[] };
  }): void {
    const cur = this.writableMirror();
    const desired = new Set(input.nodes.map((n) => n.name));
    // modules/fleet-topology.nix has `zones`, no top-level `nodes` — every node must carry a zone for renderOverlay to emit it.
    const firstZone = [...cur.zonesMeta].sort((a, b) => a.index - b.index)[0]?.name ?? 'sim-zone';
    const zoneOf = (name: string, spec?: Record<string, unknown>): string => {
      const fromSpec = spec && typeof spec.zone === 'string' && spec.zone ? spec.zone : '';
      const cz = cur.fleet?.nodes?.[name]?.zone;
      return fromSpec || (typeof cz === 'string' && cz ? cz : firstZone);
    };
    const nodes: Record<string, Record<string, unknown>> = {};
    // The engine derives data/BMC IPs from list position — ordering must never depend on the node name.
    input.nodes.forEach(({ name, spec }, i) => {
      nodes[name] = { ...spec, zone: zoneOf(name, spec), index: i };
    });
    for (const name of Object.keys(cur.fleet?.nodes ?? {})) {
      if (!desired.has(name)) nodes[name] = { enable: false, zone: zoneOf(name) };
    }
    const defaults: Record<string, unknown> = { ...(cur.fleet?.defaults ?? {}) };
    if (input.bmcDefaults?.username && input.bmcDefaults?.password) defaults.bmc = input.bmcDefaults;
    const fleet: FleetMirror = { network: cur.fleet?.network ?? {}, defaults, nodes };
    let baremetal = cur.baremetal;
    let baremetalOwned = cur.baremetalOwned;
    if (input.baremetal) {
      const bmNodes: Record<string, Record<string, unknown>> = {};
      input.baremetal.nodes.forEach(({ name, spec }, i) => {
        bmNodes[name] = { ...spec, index: i };
      });
      baremetal = { nics: input.baremetal.nics, arch: input.baremetal.arch, nodes: bmNodes };
      baremetalOwned = true;
    }
    const mode = input.mode ?? cur.mode;
    this.mirror = { ...cur, fleet, fleetOwned: true, mode, baremetal, baremetalOwned };
    this.writeOverlay();
    const disabled = Object.values(nodes).filter((n) => n.enable === false).length;
    this.log.log(
      `wrote stack.local.nix fleet (mode=${mode}, ${input.nodes.length} vm nodes${disabled ? `, ${disabled} disabled` : ''}${
        input.baremetal ? `, ${input.baremetal.nodes.length} bare-metal nodes` : ''
      })`,
    );
  }

  private writeOverlay(): void {
    if (this.mirror) {
      const path = this.overlayPath();
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, this.renderOverlay(this.mirror));
      renameSync(tmp, path);
      // overlay changed → invalidate so the next read re-evals and no in-flight build caches its
      // pre-overlay result; armRefreshEval below arms the one-shot --refresh-eval-cache.
      this.rendered.invalidateRenderedConfig();
      this.rendered.armRefreshEval();
    }
  }

  private renderOverlay(m: Mirror): string {
    const nixStr = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$\{/g, '\\${')}"`;
    const toNix = (v: unknown, indent: string): string => {
      if (typeof v === 'string') return nixStr(v);
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (Array.isArray(v)) return `[ ${v.map((x) => toNix(x, indent)).join(' ')} ]`;
      if (v && typeof v === 'object') {
        const entries = Object.entries(v as Record<string, unknown>).filter(
          ([, val]) => val !== null && val !== undefined,
        );
        if (entries.length === 0) return '{ }';
        return `{\n${entries.map(([k, val]) => `${indent}  ${nixStr(k)} = ${toNix(val, indent + '  ')};`).join('\n')}\n${indent}}`;
      }
      return 'null';
    };
    const block = (o: Record<string, string>) =>
      Object.entries(o)
        .map(([k, v]) => `    ${nixStr(k)} = ${nixStr(v)};`)
        .join('\n');
    const lines = [
      '# GENERATED by the control center (apps/local-lab overlay-store.ts) — do not edit by hand.',
      '# Imported by devenv.nix when present; sets stackOverrides/stackCounts/identity + fleet topology.',
      '{ ... }:',
      '{',
      `  stackOverrides.hub = {\n${block(m.hub)}\n  };`,
      `  stackOverrides.spoke = {\n${block(m.spoke)}\n  };`,
      `  stackCounts.hub = ${m.counts.hub};`,
      `  stackCounts.spoke = ${m.counts.spoke};`,
      `  identity.pg.user = ${nixStr(m.identity.pg.user)};`,
      `  identity.pg.password = ${nixStr(m.identity.pg.password)};`,
      `  identity.pg.db = ${nixStr(m.identity.pg.db)};`,
      `  identity.orgId = ${nixStr(m.identity.orgId)};`,
      `  osLayerCache.resolvers = ${nixStr(m.osLayerCache.resolvers)};`,
      `  lan.expose = ${m.lan.expose};`,
      `  telemetry.enable = ${m.telemetry.enable};`,
    ];
    // a plain line would outrank the claim script's mkOptionDefault stack.slot.nix — only pin a slot the CC set
    if (m.slotOwned) lines.push(`  stack.slot = ${m.slot};`);
    if (m.osLayerCache.originHost) {
      lines.push(`  osLayerCache.originHost = ${nixStr(m.osLayerCache.originHost)};`);
    }
    for (const [k, v] of Object.entries(m.ports)) {
      if (isPortOverride(k, v, m.portDefaults)) lines.push(`  ports.${k} = ${v};`);
    }
    if (m.fleetOwned && m.fleet) {
      const bmc = (m.fleet.defaults as { bmc?: unknown }).bmc;
      if (bmc && typeof bmc === 'object') lines.push(`  fleet.defaults.bmc = ${toNix(bmc, '  ')};`);
      const firstZone = [...m.zonesMeta].sort((a, b) => a.index - b.index)[0]?.name ?? 'sim-zone';
      const byZone = new Map<string, [string, Record<string, unknown>][]>();
      for (const [name, spec] of Object.entries(m.fleet.nodes)) {
        const z = typeof spec.zone === 'string' && spec.zone ? spec.zone : firstZone;
        if (!byZone.has(z)) byZone.set(z, []);
        byZone.get(z)!.push([name, spec]);
      }
      for (const [zone, entries] of byZone) {
        entries.sort((a, b) => (Number(a[1].index) || 0) - (Number(b[1].index) || 0));
        entries.forEach(([name, spec], i) => {
          const rest = { ...spec };
          delete rest.zone;
          const out = rest.enable === false ? { enable: false } : { ...rest, index: i };
          lines.push(`  fleet.zones.${nixStr(zone)}.nodes.${nixStr(name)} = ${toNix(out, '  ')};`);
        });
      }
    }
    if (m.fleetOwned && m.mode === 'baremetal') lines.push(`  fleet.mode = ${nixStr('baremetal')};`);
    if (m.baremetalOwned && m.baremetal) {
      const iface = m.baremetal.nics[0] ?? '';
      lines.push(`  fleet.baremetal.iface = ${nixStr(iface)};`);
      lines.push(`  fleet.baremetal.ifaceIp = ${nixStr(resolveIfaceIp(iface))};`);
      lines.push(`  fleet.baremetal.arch = ${nixStr(m.baremetal.arch)};`);
      for (const [name, spec] of Object.entries(m.baremetal.nodes)) {
        lines.push(`  fleet.baremetal.nodes.${nixStr(name)} = ${toNix(spec, '  ')};`);
      }
    }
    lines.push('}', '');
    return lines.join('\n');
  }

  hubRepoPathOverride(): string | undefined {
    return this.overrides().hub.HUB_REPO_PATH;
  }

  bmUplink(): { iface: string; ip: string } | null {
    if (this.fleetMode() !== 'baremetal') return null;
    const bm = this.baremetalConfig();
    const iface = bm?.nics[0] ?? '';
    if (!iface) return null;
    const ip = resolveIfaceIp(iface);
    if (!ip) return null;
    return { iface, ip };
  }

  stackSummary(): { counts: { hub: number; spoke: number }; lifecycleWorkerConcurrency: number } {
    const positive = (v: string | undefined, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const knobDefault = resolvedKnobs('spoke', this.current().stackDefaults).find(
      (k) => k.env === 'LIFECYCLE_WORKER_CONCURRENCY',
    )?.default;
    const override = this.overrides().spoke.LIFECYCLE_WORKER_CONCURRENCY;
    return {
      counts: this.counts(),
      lifecycleWorkerConcurrency: positive(override, positive(knobDefault, 1)),
    };
  }
}
