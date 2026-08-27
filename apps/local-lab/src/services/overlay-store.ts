import { ConflictException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ZoneApplyPlan, ZoneWrite } from '@repo/local-lab-contract';
import {
  APPLY_ACTION,
  applyClassFor,
  applySatisfies,
  strongestApplyClass,
  writableFor,
  type ApplyClass,
  type RejectedEntry,
  type RestartState,
  type StackPending,
} from '@repo/local-lab-contract';
import { getErrorMessage } from '../common/errors';
import { resolveIfaceIp } from '../common/net';
import type { KnobCatalogEntry, KnobProvenance, KnobValue } from '../common/pc-schemas';
import { DevenvEnvPinsEvalSchema, DevenvSeedEvalSchema, parseBoundary } from '../common/pc-schemas';
import { secretDigest } from '../common/redact';
import type { ConfigTree, ConfigTreeEntry, StackKnob } from '../contract';
import { HOSTS, mkPgUrl, primeNixPorts, STACK_SLOT } from '../ports';
import { devenvRoot } from './paths';
import { RenderedConfigService } from './rendered-config.service';
import {
  catalogByPath,
  editablePortsFrom,
  envKnobPath,
  knobsFromCatalog,
  portDefaultsFromCatalog,
  readOnlyPortRows,
  readOnlyPortsFrom,
  servicePortRows,
  STACK_PORTS,
  type EnvPins,
  type StackGroup,
} from './stack-knobs';
import { StackRegistryClient } from './stack-registry-client';

const execFileP = promisify(execFile);

type ZoneMeta = { name: string; index: number; bridges: number };

/** Zones the overlay holds out with `enable = false`. They must be re-emitted on every write or the
 *  next eval brings them back. */
const disabledZoneNames = (fleet: FleetEval | undefined): string[] =>
  Object.entries(fleet?.zones ?? {})
    .filter(([, z]) => z.enable === false)
    .map(([name]) => name)
    .sort();

/** The zone set the base renders byte-identically to the pre-zones output: one zone, index 0, one
 *  bridge, the canonical name. modules/fleet-topology.nix keys `isDefaultSingle` on the same three. */
const isDefaultSingleZoneSet = (zones: ZoneMeta[]): boolean =>
  zones.length === 1 && zones[0].index === 0 && zones[0].bridges === 1 && zones[0].name === 'sim-zone';
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

/** A node the overlay holds out with `enable = false`. `baseDeclared` says another file still declares
 *  it, so dropping the tombstone restores the node — the write path refuses that prune. */
export type FleetTombstoneMeta = { name: string; zone: string; baseDeclared: boolean };

export type BareMetalMirror = {
  nics: string[];
  arch: string;
  nodes: Record<string, Record<string, unknown>>;
};

type FleetEvalNode = Record<string, unknown> & { enable?: boolean; index?: number };
type FleetEvalZone = { enable?: boolean; index?: number; bridges?: number; nodes?: Record<string, FleetEvalNode> };
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
  const byZoneIndex = Object.entries(zones)
    .filter(([, z]) => z.enable !== false)
    .sort(([, a], [, b]) => (a.index ?? 0) - (b.index ?? 0));
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
  catalog: KnobCatalogEntry[];
  provenance: KnobProvenance[];
  /** Per-path values as of the last eval; the typed fields below overlay anything saved since. */
  values: KnobValue[];
  /** Knob path -> the variable pinning it. A pinned path outranks the overlay, so a write to one is
   *  rejected rather than persisted. */
  envPins: EnvPins;
  portKeys: { editable: string[]; readOnly: string[] };
  ports: Record<string, number>;
  portDefaults: Record<string, number>;
  readOnlyPorts: Record<string, number>;
  bridges: LabBridge[];
  fleet: FleetMirror | null;
  fleetOwned: boolean;
  mode: 'vm' | 'baremetal';
  fleetAutoStart: boolean;
  baremetal: BareMetalMirror | null;
  baremetalOwned: boolean;
  zonesMeta: ZoneMeta[];
  fleetNodeFiles: Record<string, Record<string, string[]>>;
  zoneCapacity: number;
  zoneFiles: Record<string, string[]>;
  zoneTombstones: string[];
  options: Record<string, string | number | boolean>;
};

/** Hub is pinned to 1: modules/hub.nix probes every replica on the base port, so a replica beyond the
 *  first reports the primary's health and nothing in Nix consumes stackCounts to start one anyway. */
const MAX_HUBS = 1;
const SECRET_MASK = '***';
const MAX_SPOKES = 8;

const clampCount = (v: unknown, max: number): number => {
  const x = Number(v);
  return Number.isInteger(x) && x >= 1 ? Math.min(x, max) : 1;
};

const isPortOverride = (key: string, value: number, defaults: Record<string, number>): boolean =>
  defaults[key] !== value;

/** An empty password stays empty: masking it would make "unset" and "hidden" read the same. The
 *  overlay keeps the real value, and setStackConfig reads SECRET_MASK back as "unchanged". */
const maskIdentity = (identity: IdentityCfg): IdentityCfg =>
  identity.pg.password === '' ? identity : { ...identity, pg: { ...identity.pg, password: SECRET_MASK } };

// ServiceSchema's port is a plain z.number(), which rejects NaN — never let one out of the eval boundary.
const nonNegativeInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/** The one file the control center writes. `labFleetNodeFiles` reports repo-relative paths, so a node
 *  listing only this file is declared nowhere else. */
const OVERLAY_FILE = 'stack.local.nix';

/** Every field a stack write can touch, so one pass over the patch can route each path without
 *  rebuilding the mirror per entry. */
type Draft = {
  hub: Record<string, string>;
  spoke: Record<string, string>;
  identity: IdentityCfg;
  osLayerCache: OsLayerCfg;
  lan: LanCfg;
  telemetry: TelemetryCfg;
  ports: Record<string, number>;
  options: Record<string, string | number | boolean>;
};

const draftFrom = (cur: Mirror): Draft => ({
  hub: { ...cur.hub },
  spoke: { ...cur.spoke },
  identity: { pg: { ...cur.identity.pg }, orgId: cur.identity.orgId },
  osLayerCache: { ...cur.osLayerCache },
  lan: { ...cur.lan },
  telemetry: { ...cur.telemetry },
  ports: { ...cur.ports },
  options: { ...cur.options },
});

/** Types a submitted string against the kind and the range the catalog declares. Undefined means it
 *  does not coerce, which is a rejection rather than a silent zero or false. */
export function coerceOption(
  entry: Pick<KnobCatalogEntry, 'kind' | 'bounds'>,
  raw: string,
): string | number | boolean | undefined {
  const { kind, bounds } = entry;
  if (kind === 'bool') return raw === 'true' ? true : raw === 'false' ? false : undefined;
  if (kind === 'number' || kind === 'port') {
    // Number('') is 0, which clears the integer test and any bounds a knob declares
    if (raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n)) return undefined;
    if (bounds && (n < bounds.min || n > bounds.max)) return undefined;
    // stricter than unsignedInt16 on purpose: port 0 types fine and binds nothing
    if (kind === 'port' && !(n >= 1 && n <= 65535)) return undefined;
    return n;
  }
  return raw;
}

/** Paths a typed field already owns. The generic option writer must never also hold one, or the same
 *  path would round-trip through two places. */
export const RESERVED_OPTION_PREFIXES: readonly string[] = [
  'stackDefaults.hub.',
  'stackDefaults.spoke.',
  'ports.',
  'identity.',
  'osLayerCache.',
  'lan.expose',
  'telemetry.enable',
  'stack.slot',
  'stackCounts.',
  'fleet.',
];

const asString = (v: string | number | boolean): string => String(v);

const declaredDefault = (entry: KnobCatalogEntry): string | null =>
  entry.default === null || entry.default === undefined ? null : String(entry.default);

/** True when the write leaves a line in the overlay, matching what renderOverlay emits per family: an
 *  env knob is a line whenever the map holds it, everything else only when it differs from the default. */
function leavesOverride(draft: Draft, path: string, entry: KnobCatalogEntry): boolean {
  for (const group of ['hub', 'spoke'] as const) {
    const prefix = `stackDefaults.${group}.`;
    if (path.startsWith(prefix)) return draft[group][path.slice(prefix.length)] !== undefined;
  }
  return draftValue(draft, path) !== declaredDefault(entry);
}

function draftValue(draft: Draft, path: string): string | null {
  for (const group of ['hub', 'spoke'] as const) {
    const prefix = `stackDefaults.${group}.`;
    if (path.startsWith(prefix)) return draft[group][path.slice(prefix.length)] ?? null;
  }
  if (path.startsWith('ports.')) {
    const port = draft.ports[path.slice('ports.'.length)];
    return port === undefined ? null : String(port);
  }
  const reads: Record<string, () => string> = {
    'identity.pg.user': () => draft.identity.pg.user,
    'identity.pg.password': () => draft.identity.pg.password,
    'identity.pg.db': () => draft.identity.pg.db,
    'identity.orgId': () => draft.identity.orgId,
    'osLayerCache.originHost': () => draft.osLayerCache.originHost,
    'osLayerCache.resolvers': () => draft.osLayerCache.resolvers,
    'lan.expose': () => String(draft.lan.expose),
    'telemetry.enable': () => String(draft.telemetry.enable),
  };
  const read = reads[path];
  if (read) return read();
  const opt = draft.options[path];
  return opt === undefined ? null : String(opt);
}

/** Routes one coerced value into the draft. False means no writer owns the path. A null reverts:
 *  a typed field falls back to the catalog default, and a generic option loses its line entirely. */
function applyToDraft(
  draft: Draft,
  path: string,
  value: string | number | boolean | null,
  cur: Mirror,
  entry: KnobCatalogEntry,
): boolean {
  const fallback = entry.default === null || entry.default === undefined ? '' : String(entry.default);
  for (const group of ['hub', 'spoke'] as const) {
    const prefix = `stackDefaults.${group}.`;
    if (path.startsWith(prefix)) {
      const key = path.slice(prefix.length);
      if (value === null) delete draft[group][key];
      else draft[group][key] = asString(value);
      return true;
    }
  }
  if (path.startsWith('ports.')) {
    const key = path.slice('ports.'.length);
    if (!cur.portKeys.editable.includes(key)) return false;
    const fallbackPort = cur.portDefaults[key];
    if (value === null) {
      if (fallbackPort === undefined) delete draft.ports[key];
      else draft.ports[key] = fallbackPort;
      return true;
    }
    if (typeof value !== 'number') return false;
    draft.ports[key] = value;
    return true;
  }
  const typed: Record<string, (v: string) => void> = {
    'identity.pg.user': (v) => void (draft.identity.pg.user = v),
    // stackConfig() hands out SECRET_MASK, so a client echoing the field back means "leave it":
    // without this the next save would store the mask itself as the Postgres password.
    'identity.pg.password': (v) => void (v === SECRET_MASK ? undefined : (draft.identity.pg.password = v)),
    'identity.pg.db': (v) => void (draft.identity.pg.db = v),
    'identity.orgId': (v) => void (draft.identity.orgId = v),
    'osLayerCache.originHost': (v) => void (draft.osLayerCache.originHost = v),
    'osLayerCache.resolvers': (v) => void (draft.osLayerCache.resolvers = v),
    'lan.expose': (v) => void (draft.lan.expose = v === 'true'),
    'telemetry.enable': (v) => void (draft.telemetry.enable = v === 'true'),
  };
  const write = typed[path];
  if (write) {
    write(value === null ? fallback : asString(value));
    return true;
  }
  if (RESERVED_OPTION_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (value === null) delete draft.options[path];
  else draft.options[path] = value;
  return true;
}

/** Comparison-only fingerprints, so an overridden secret is detectable without either value reaching
 *  the client. */
const digestPair = (value: string | null, fallback: string | null) => ({
  valueDigest: secretDigest(value ?? ''),
  defaultDigest: secretDigest(fallback ?? ''),
});

/** Null means the two cannot be told apart. It happens for a secret with nothing on either side: an
 *  unset secret and one the server could not read look identical, and reporting `false` would lie. */
function overriddenOf(secret: boolean, value: string | null, fallback: string | null): boolean | null {
  if (!secret) return value !== fallback;
  const { valueDigest, defaultDigest } = digestPair(value, fallback);
  if (!valueDigest && !defaultDigest) return null;
  return valueDigest !== defaultDigest;
}

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
    catalog: [],
    provenance: [],
    values: [],
    envPins: {},
    portKeys: { editable: [], readOnly: [] },
    ports: {},
    portDefaults: {},
    readOnlyPorts: {},
    bridges: [],
    fleet: null,
    fleetNodeFiles: {},
    zoneCapacity: 0,
    zoneFiles: {},
    zoneTombstones: [],
    options: {},
    fleetOwned: false,
    mode: 'vm',
    fleetAutoStart: true,
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

  private savedNotApplied = new Set<string>();

  private readonly startedAtMs = Date.now();

  private ownWriteMtimeMs: number | null = null;

  private seededMtimeMs: number | null = null;

  private zoneSteps: ZoneApplyPlan['steps'] = [];

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
    this.clearSatisfiedBy('rebind-recreate');
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

  /** Nodes the overlay holds out with `enable = false`. An unknown or empty file list reads as
   *  base-declared: a refused prune is recoverable, a silently restored node is not. */
  fleetTombstones(): FleetTombstoneMeta[] {
    const cur = this.current();
    const firstZone = [...cur.zonesMeta].sort((a, b) => a.index - b.index)[0]?.name ?? 'sim-zone';
    return Object.entries(cur.fleet?.nodes ?? {})
      .filter(([, spec]) => spec.enable === false)
      .map(([name, spec]) => {
        const zone = typeof spec.zone === 'string' && spec.zone ? spec.zone : firstZone;
        const files = cur.fleetNodeFiles[zone]?.[name];
        const declaredElsewhere = (files ?? []).filter((f) => f !== OVERLAY_FILE);
        return { name, zone, baseDeclared: files === undefined || declaredElsewhere.length > 0 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  zonesMeta(): ZoneMeta[] {
    return this.current().zonesMeta;
  }

  zoneFiles(): Record<string, string[]> {
    return this.current().zoneFiles;
  }

  zoneCapacity(): number {
    return this.current().zoneCapacity;
  }

  isSeeded(): boolean {
    return this.current().seeded;
  }

  /** Enabled node names per zone, from the mirror rather than a second flatten. */
  fleetNodesByZone(): Record<string, string[]> {
    const cur = this.current();
    const firstZone = [...cur.zonesMeta].sort((a, b) => a.index - b.index)[0]?.name ?? 'sim-zone';
    const out: Record<string, string[]> = {};
    for (const zone of cur.zonesMeta) out[zone.name] = [];
    for (const [name, spec] of Object.entries(cur.fleet?.nodes ?? {})) {
      if (spec.enable === false) continue;
      const zone = typeof spec.zone === 'string' && spec.zone ? spec.zone : firstZone;
      out[zone] = [...(out[zone] ?? []), name];
    }
    return out;
  }

  /** Replaces the declared zone set. A zone another file declares is tombstoned rather than dropped,
   *  because dropping its key lets the base declaration come back. */
  setZonesConfig(input: {
    zones: ZoneWrite[];
    nodeZones: Record<string, string>;
    steps?: ZoneApplyPlan['steps'];
  }): void {
    const cur = this.writableMirror();
    const desired = new Set(input.zones.map((z) => z.name));
    const removed = cur.zonesMeta.filter((z) => !desired.has(z.name)).map((z) => z.name);
    const tombstones = [
      ...cur.zoneTombstones.filter((name) => !desired.has(name)),
      ...removed.filter((name) => (cur.zoneFiles[name] ?? []).some((file) => file !== OVERLAY_FILE)),
    ];
    const nodes: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(cur.fleet?.nodes ?? {})) {
      const zone = input.nodeZones[name];
      nodes[name] = zone === undefined ? spec : { ...spec, zone };
    }
    this.mirror = {
      ...cur,
      zonesMeta: [...input.zones].sort((a, b) => a.index - b.index),
      zoneTombstones: [...new Set(tombstones)].sort(),
      fleet: cur.fleet ? { ...cur.fleet, nodes } : cur.fleet,
      fleetOwned: true,
    };
    this.writeOverlay();
    // the plan lived in the page's own state, so a refresh lost work the stack still needed. it is
    // outstanding until the zone-seed op reports it applied.
    for (const zone of input.zones) this.savedNotApplied.add(`fleet.zones.${zone.name}`);
    for (const name of removed) this.savedNotApplied.add(`fleet.zones.${name}`);
    if (input.steps) this.zoneSteps = input.steps;
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
          'configModel',
          'portGroups',
          'labBridges',
          'identity',
          'osLayerCache',
          'lan',
          'telemetry',
          'ports',
          'fleet',
          'labFleetNodeFiles',
          'labZoneCapacity',
          'labZoneFiles',
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
      const catalog = j.configModel?.catalog ?? [];
      const provenance = j.configModel?.provenance ?? [];
      const values = j.configModel?.values ?? [];
      const envPins = await this.seedEnvPins();
      const portKeys = { editable: j.portGroups?.editable ?? [], readOnly: j.portGroups?.readOnly ?? [] };
      const ports = editablePortsFrom(j.ports, portKeys.editable);
      const portDefaults = portDefaultsFromCatalog(catalog);
      const primed = primeNixPorts(j.ports ?? {});
      if (primed.skipped.length > 0) {
        this.log.warn(`ports eval reported unusable values, keeping the bootstrap port: ${primed.skipped.join(', ')}`);
      }
      const readOnlyPorts = readOnlyPortsFrom(j.ports, portKeys.readOnly);
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
      const fleetAutoStart = j.fleet?.autoStart ?? true;
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
        ? Object.entries(j.fleet.zones)
            .filter(([, z]) => z.enable !== false)
            .map(([name, z]) => ({
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
        catalog,
        provenance,
        values,
        envPins,
        portKeys,
        ports,
        portDefaults,
        readOnlyPorts,
        bridges,
        fleet,
        fleetOwned: this.overlayHasFleet(),
        mode,
        fleetAutoStart,
        baremetal,
        baremetalOwned: this.overlayHasBaremetal(),
        zonesMeta,
        fleetNodeFiles: j.labFleetNodeFiles ?? {},
        zoneCapacity: j.labZoneCapacity ?? 0,
        zoneFiles: j.labZoneFiles ?? {},
        zoneTombstones: disabledZoneNames(j.fleet),
        options: this.mirror?.options ?? {},
      };
      this.seededMtimeMs = this.overlayMtimeMs();
      this.log.log(
        `seeded stack overrides (hub=${Object.keys(this.mirror.hub).length} spoke=${Object.keys(this.mirror.spoke).length} knobs; catalog=${catalog.length}; pins=${Object.keys(envPins).length}; pg user=${identity.pg.user}; bridges=${bridges.length}; fleet nodes=${Object.keys(fleet?.nodes ?? {}).length})`,
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

  /** Read on its own: modules/env-pins.nix may not be in this checkout, and a missing module means no
   *  pin exists to protect — folding it into the seed eval would fail the whole seed instead. */
  private async seedEnvPins(): Promise<EnvPins> {
    try {
      const { stdout } = await execFileP('devenv', ['eval', 'envPins'], {
        cwd: this.devenvRoot,
        timeout: 120_000,
      });
      const raw = parseBoundary(DevenvEnvPinsEvalSchema, JSON.parse(stdout), 'devenv envPins eval').envPins;
      return Object.fromEntries((raw ?? []).map((pin) => [pin.path, pin.var]));
    } catch (e) {
      const message = getErrorMessage(e);
      const log = /envPins.*not found/.test(message) ? this.log.debug : this.log.warn;
      log.call(this.log, `no env pins read, treating every knob as unpinned: ${message}`);
      return {};
    }
  }

  originHost(): string {
    return this.current().osLayerCache.originHost;
  }

  private provenanceStale = false;

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
    // reseed() is async and writes are not, so a moved file can only be refused here: rebuilding from
    // the mirror would re-render an edited-away or deleted override as if the operator never touched it.
    if (this.overlayMtimeMs() !== this.seededMtimeMs) {
      void this.reseed();
      throw new ServiceUnavailableException(
        'stack.local.nix changed on disk since it was last read, so saving now would rebuild it from overrides that file no longer has. It is being re-read — retry the save.',
      );
    }
    return m;
  }

  /** Recovery: every other write rebuilds from the mirror, which an unseeded one cannot do, so a removal
   *  is the only write still reachable. One-line assignments only — a half-removed block orphans its body. */
  private dropOverlayLines(paths: string[]): { applied: string[]; rejected: RejectedEntry[] } {
    const path = this.overlayPath();
    if (!existsSync(path)) {
      throw new ServiceUnavailableException(
        'there is no stack.local.nix to recover from — the devenv eval is failing for another reason.',
      );
    }
    const before = readFileSync(path, 'utf8');
    const applied: string[] = [];
    const rejected: RejectedEntry[] = [];
    let text = before;
    for (const p of paths) {
      const line = new RegExp(`^ {2}${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} = [^\n]*;[ \t]*\n`, 'm');
      if (!line.test(text)) {
        rejected.push({ path: p, reason: 'no-overlay-line' });
        continue;
      }
      text = text.replace(line, '');
      applied.push(p);
    }
    if (applied.length > 0) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, path);
      this.rendered.invalidateRenderedConfig();
      this.rendered.armRefreshEval();
      this.log.warn(`recovered stack.local.nix by dropping ${applied.join(', ')} — the mirror was unseeded`);
      void this.reseed();
    }
    return { applied: applied.sort(), rejected: rejected.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  private overlayPath(): string {
    return join(this.devenvRoot, OVERLAY_FILE);
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
    else this.reseedIfOverlayMoved();
    const { seeded, identity, osLayerCache, lan, telemetry, catalog, envPins, portKeys, ports } = cur;
    const byPath = catalogByPath(catalog);
    // Same resolver the config tree reads, so the two surfaces cannot report different values.
    const fillDynamic =
      (group: StackGroup) =>
      (k: StackKnob): StackKnob => {
        const value = this.derivedValue(envKnobPath(group, k.env), cur);
        return value === undefined ? k : { ...k, default: value, source: 'derived' };
      };
    return {
      seeded,
      slot: cur.slot,
      knobs: {
        hub: knobsFromCatalog('hub', catalog, envPins).map(fillDynamic('hub')),
        spoke: knobsFromCatalog('spoke', catalog, envPins).map(fillDynamic('spoke')),
      },
      topology: { zones: cur.zonesMeta.length, bridges: cur.bridges.length },
      ports: STACK_PORTS,
      servicePorts: [
        ...servicePortRows(portKeys.editable, ports, false, byPath),
        ...readOnlyPortRows(portKeys.readOnly, cur.readOnlyPorts, byPath),
      ],
      values: this.overrides(),
      identity: maskIdentity(identity),
      osLayerCache,
      lan,
      telemetry,
    };
  }

  /** Computed here, not read from Nix. Keyed by canonical path so the stack editor and the config
   *  tree cannot resolve the same knob differently. */
  private derivedValue(path: string, cur: Mirror): string | undefined {
    if (path === envKnobPath('hub', 'HUB_REPO_PATH')) return process.env.HUB_REPO_PATH || undefined;
    if (path === envKnobPath('hub', 'DATABASE_URL')) {
      const { pg } = cur.identity;
      return pg.user && pg.db ? mkPgUrl(pg, cur.ports.postgres) : undefined;
    }
    if (path === envKnobPath('spoke', 'DISCOVERY_BASE_URL')) {
      const host = cur.osLayerCache.originHost;
      return host ? `https://${host}/brokkr-live-light` : undefined;
    }
    return undefined;
  }

  /** Weakest first: the last eval, the mirror's own fields, then derived. The eval layer covers every
   *  catalogued path, so a knob can no longer go missing here and report its default instead. */
  private effectiveValues(cur: Mirror): Map<string, string | null> {
    const values = new Map<string, string | null>();
    for (const { path, value } of cur.values) {
      values.set(path, value === null || value === undefined ? null : String(value));
    }
    const tracked: [string, string][] = [
      ['stack.slot', String(cur.slot)],
      ['stackCounts.hub', String(cur.counts.hub)],
      ['stackCounts.spoke', String(cur.counts.spoke)],
      ['identity.pg.user', cur.identity.pg.user],
      ['identity.pg.password', cur.identity.pg.password],
      ['identity.pg.db', cur.identity.pg.db],
      ['identity.orgId', cur.identity.orgId],
      ['osLayerCache.originHost', cur.osLayerCache.originHost],
      ['osLayerCache.resolvers', cur.osLayerCache.resolvers],
      ['lan.expose', String(cur.lan.expose)],
      ['telemetry.enable', String(cur.telemetry.enable)],
      ['fleet.mode', cur.mode],
      ['fleet.autoStart', String(cur.fleetAutoStart)],
    ];
    for (const [key, value] of tracked) values.set(key, value);
    for (const [key, port] of Object.entries(cur.ports)) values.set(`ports.${key}`, String(port));
    for (const group of ['hub', 'spoke'] as const) {
      for (const [key, value] of Object.entries(cur[group])) values.set(envKnobPath(group, key), value);
    }
    for (const entry of cur.catalog) {
      const derived = this.derivedValue(entry.path, cur);
      if (derived !== undefined) values.set(entry.path, derived);
    }
    return values;
  }

  /** The module system attributes an env knob's files to the containing attrset, not the key, so a knob
   *  reads both its defaults block and the overrides block it merges with. */
  private definedIn(entry: KnobCatalogEntry, provenance: Map<string, KnobProvenance>): string[] {
    // per-key first: an env knob's own path names the module supplying its default, so returning
    // that early reports every override as a default. containers stay weakest-first for the chip.
    const cut = entry.path.lastIndexOf('.');
    if (cut >= 0) {
      const key = entry.path.slice(cut + 1);
      const containers = [entry.path.slice(0, cut), ...(entry.overrideFrom ? [entry.overrideFrom] : [])];
      const viaKey = [...new Set(containers.flatMap((c) => provenance.get(c)?.perKey[key] ?? []))];
      if (viaKey.length > 0) return viaKey;
    }
    return provenance.get(entry.path)?.files ?? [];
  }

  configTree(): ConfigTree {
    const cur = this.current();
    if (!cur.seeded) void this.reseed();
    else if (this.provenanceStale) {
      this.provenanceStale = false;
      void this.reseed();
    } else this.reseedIfOverlayMoved();
    const provenance = new Map(cur.provenance.map((entry) => [entry.path, entry]));
    const values = this.effectiveValues(cur);
    const entries: ConfigTreeEntry[] = cur.catalog.map((entry) => {
      const fallback = entry.default === null || entry.default === undefined ? null : String(entry.default);
      const value = values.has(entry.path) ? (values.get(entry.path) ?? null) : fallback;
      const pinnedBy = cur.envPins[entry.path];
      return {
        path: entry.path,
        label: entry.label,
        group: entry.group,
        description: entry.description,
        value: entry.secret ? SECRET_MASK : value,
        default: entry.secret ? SECRET_MASK : fallback,
        overridden: overriddenOf(entry.secret, value, fallback),
        writable: writableFor(entry.path, entry.editable),
        kind: entry.kind,
        choices: entry.choices,
        danger: entry.danger,
        applyClass: applyClassFor(entry.path),
        definedIn: this.definedIn(entry, provenance),
        secret: entry.secret,
        ...(entry.secret ? digestPair(value, fallback) : {}),
        ...(pinnedBy ? { pinnedBy } : {}),
      };
    });
    return { seeded: cur.seeded, entries };
  }

  async setStackConfig(cfg: {
    entries: Record<string, string | null>;
    slot?: number;
  }): Promise<{ applied: string[]; rejected: RejectedEntry[] }> {
    const applied: string[] = [];
    const touched: string[] = [];
    const rejected: RejectedEntry[] = [];
    const reject = (path: string, reason: RejectedEntry['reason'], detail?: string): void => {
      rejected.push(detail === undefined ? { path, reason } : { path, reason, detail });
    };
    // a slot move rebases the mirror (fleet/port pins would outrank the new slot's derived defaults), so
    // co-submitted entries are dropped by name — the operator was told pins reset.
    let slotChanged = false;
    if (cfg.slot !== undefined && cfg.slot !== this.current().slot) {
      await this.setStackSlot(cfg.slot);
      applied.push('stack.slot');
      slotChanged = true;
    }
    const paths = Object.keys(cfg.entries);
    if (!slotChanged && !this.current().seeded && paths.length > 0 && paths.every((p) => cfg.entries[p] === null)) {
      return this.dropOverlayLines(paths);
    }
    const cur = this.writableMirror();
    const byPath = catalogByPath(cur.catalog);
    const draft = draftFrom(cur);

    for (const [path, raw] of Object.entries(cfg.entries)) {
      if (slotChanged) {
        reject(path, 'slot-move-drops-entries');
        continue;
      }
      const entry = byPath.get(path);
      if (!entry) {
        reject(path, 'not-catalogued');
        continue;
      }
      // an env pin outranks every overlay line, so persisting a pinned path would answer ok and change nothing
      if (cur.envPins[path] !== undefined) {
        reject(path, 'pinned', cur.envPins[path]);
        continue;
      }
      if (!writableFor(entry.path, entry.editable)) {
        reject(path, 'no-writer');
        continue;
      }
      const coerced = raw === null ? null : coerceOption(entry, raw);
      if (coerced === undefined) {
        reject(path, 'not-coercible', entry.kind);
        continue;
      }
      if (!applyToDraft(draft, path, coerced, cur, entry)) {
        reject(path, 'no-writer');
        continue;
      }
      touched.push(path);
      if (leavesOverride(draft, path, entry)) applied.push(path);
    }

    const telemetryChanged = draft.telemetry.enable !== cur.telemetry.enable;
    // every path the write touched, not just the ones leaving an override: reverting a port back to
    // its default moves the effective value too, and that still needs the daemons recreated
    if (touched.some((path) => applyClassFor(path) === 'rebind-recreate')) this.armRebindPending();

    this.mirror = {
      ...cur,
      seeded: true,
      hub: draft.hub,
      spoke: draft.spoke,
      identity: draft.identity,
      osLayerCache: draft.osLayerCache,
      lan: draft.lan,
      telemetry: draft.telemetry,
      ports: draft.ports,
      options: draft.options,
    };
    this.writeOverlay();
    const portOverrides = Object.entries(draft.ports).filter(([k, v]) => isPortOverride(k, v, cur.portDefaults)).length;
    this.log.log(
      `wrote stack.local.nix (${applied.length} applied, ${rejected.length} rejected; pg user=${draft.identity.pg.user}; port overrides=${portOverrides}; lan.expose=${draft.lan.expose}; telemetry.enable=${draft.telemetry.enable})`,
    );
    if (telemetryChanged) {
      if (this.telemetryHook) this.telemetryHook();
      else this.log.warn('telemetry changed but no apply hook is registered — skipping apply');
    }
    for (const path of touched) {
      const cls = applyClassFor(path);
      // an inert knob nothing reads, and an auto knob that applied itself on save, have no action to
      // offer — recording them names a demand no button can satisfy. an unclassified path stays.
      if (cls !== null && APPLY_ACTION[cls] === null) continue;
      this.savedNotApplied.add(path);
    }
    return { applied: applied.sort(), rejected: rejected.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  /** Drops only what the apply actually reached, per APPLY_SATISFIES rather than a rank ceiling: the two
   *  reloads tie on rank, so a ceiling let a hub reload clear a spoke path it never restarted. */
  clearSatisfiedBy(performed: ApplyClass): void {
    for (const path of [...this.savedNotApplied]) {
      const cls = applyClassFor(path);
      if (cls !== null && applySatisfies(performed, cls)) this.savedNotApplied.delete(path);
    }
    if (applySatisfies(performed, 'zone-apply')) this.zoneSteps = [];
  }

  private overlayMtimeMs(): number | null {
    try {
      return statSync(this.overlayPath()).mtimeMs;
    } catch {
      return null;
    }
  }

  /** stack.local.nix is only a projection of the mirror, so a file edited or deleted underneath leaves
   *  reads serving overrides it no longer has, and the next save renders them back onto disk. */
  private reseedIfOverlayMoved(): void {
    if (this.overlayMtimeMs() === this.seededMtimeMs) return;
    void this.reseed();
  }

  /** `savedNotApplied` lives in memory, so a write this process did not make leaves it empty while the
   *  work is outstanding. Reporting that beats a clean-looking stack, which would be a guess. */
  private foreignOverlayWrite(): string | null {
    const mtime = this.overlayMtimeMs();
    if (mtime === null || mtime <= this.startedAtMs) return null;
    return mtime === this.ownWriteMtimeMs ? null : new Date(mtime).toISOString();
  }

  /** What is written and still waiting on an apply. `seeded: false` reports every count as null rather
   *  than zero, so a failed seed cannot read as a clean stack. */
  stackPending(restart: RestartState): StackPending {
    const cur = this.current();
    const paths = [...this.savedNotApplied].sort();
    const classes = [...new Set(paths.map(applyClassFor).filter((c): c is ApplyClass => c !== null))];
    return {
      seeded: cur.seeded,
      savedNotApplied: { paths, classes },
      strongestClass: strongestApplyClass(classes),
      rebindArmed: this.rebindPending,
      restart,
      resetRequired: paths.filter((path) => applyClassFor(path) === 'datastore-reset'),
      unknownSince: this.foreignOverlayWrite(),
      zoneSteps: this.zoneSteps,
    };
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
    defaults?: { cpus: number | null; memory_mb: number | null; disk_gb: number | null; arch: string | null };
    network?: Record<string, string | boolean>;
    prune?: string[];
    mode?: 'vm' | 'baremetal';
    baremetal?: { nics: string[]; arch: string; nodes: { name: string; spec: Record<string, unknown> }[] };
  }): RejectedEntry[] {
    const rejected: RejectedEntry[] = [];
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
    const pruned = new Set(input.prune ?? []);
    for (const [name, node] of Object.entries(cur.fleet?.nodes ?? {})) {
      if (desired.has(name) || pruned.has(name)) continue;
      nodes[name] = { enable: false, zone: zoneOf(name) };
      // the roster the client sent dropped it, but the overlay holds it out instead of losing it —
      // only a prune drops the line, so say so rather than answering a plain ok
      if (node.enable !== false) rejected.push({ path: `fleet.nodes.${name}`, reason: 'tombstoned' });
    }
    const defaults: Record<string, unknown> = { ...(cur.fleet?.defaults ?? {}) };
    if (input.bmcDefaults?.username && input.bmcDefaults?.password) defaults.bmc = input.bmcDefaults;
    // null clears the default so the engine value applies; omitting the field leaves it untouched
    if (input.defaults) {
      for (const key of ['cpus', 'memory_mb', 'disk_gb', 'arch'] as const) {
        const v = input.defaults[key];
        if (v === null) delete defaults[key];
        else defaults[key] = v;
      }
    }
    const network = { ...(cur.fleet?.network ?? {}), ...(input.network ?? {}) };
    const fleet: FleetMirror = { network, defaults, nodes };
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
    // an env pin outranks this overlay, so persisting a different mode would record a value the
    // next eval discards. the stack writer refuses a pinned key the same way.
    const modePin = cur.envPins?.['fleet.mode'];
    const modePinned = modePin !== undefined;
    if (modePinned && input.mode !== undefined && input.mode !== cur.mode) {
      this.log.warn(`fleet.mode is pinned by ${modePin}; keeping ${cur.mode}`);
      rejected.push({ path: 'fleet.mode', reason: 'pinned', detail: modePin });
    }
    const mode = modePinned ? cur.mode : (input.mode ?? cur.mode);
    this.mirror = { ...cur, fleet, fleetOwned: true, mode, baremetal, baremetalOwned };
    this.writeOverlay();
    const disabled = Object.values(nodes).filter((n) => n.enable === false).length;
    this.log.log(
      `wrote stack.local.nix fleet (mode=${mode}, ${input.nodes.length} vm nodes${disabled ? `, ${disabled} disabled` : ''}${
        input.baremetal ? `, ${input.baremetal.nodes.length} bare-metal nodes` : ''
      })`,
    );
    return rejected;
  }

  private writeOverlay(): void {
    if (this.mirror) {
      const path = this.overlayPath();
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, this.renderOverlay(this.mirror));
      renameSync(tmp, path);
      this.ownWriteMtimeMs = this.overlayMtimeMs();
      this.seededMtimeMs = this.ownWriteMtimeMs;
      // overlay changed → invalidate so the next read re-evals and no in-flight build caches its
      // pre-overlay result; armRefreshEval below arms the one-shot --refresh-eval-cache.
      this.rendered.invalidateRenderedConfig();
      this.rendered.armRefreshEval();
      // Re-seeding here would let a failed eval mark the mirror unseeded and block the next write,
      // so flag it: until the tree refreshes, an overridden knob still names its declaring module.
      this.provenanceStale = true;
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
      '# Imported by devenv.nix when present; sets stackOverrides/identity + fleet topology.',
      '{ ... }:',
      '{',
      `  stackOverrides.hub = {\n${block(m.hub)}\n  };`,
      `  stackOverrides.spoke = {\n${block(m.spoke)}\n  };`,
    ];
    const defaults = catalogByPath(m.catalog);
    const differs = (path: string, value: string): boolean => {
      const entry = defaults.get(path);
      return entry === undefined || value !== declaredDefault(entry);
    };
    const scalar = (path: string, value: string, render: string): void => {
      if (differs(path, value)) lines.push(`  ${path} = ${render};`);
    };
    scalar('identity.pg.user', m.identity.pg.user, nixStr(m.identity.pg.user));
    scalar('identity.pg.password', m.identity.pg.password, nixStr(m.identity.pg.password));
    scalar('identity.pg.db', m.identity.pg.db, nixStr(m.identity.pg.db));
    scalar('identity.orgId', m.identity.orgId, nixStr(m.identity.orgId));
    scalar('osLayerCache.resolvers', m.osLayerCache.resolvers, nixStr(m.osLayerCache.resolvers));
    scalar('lan.expose', String(m.lan.expose), String(m.lan.expose));
    scalar('telemetry.enable', String(m.telemetry.enable), String(m.telemetry.enable));
    // a plain line would outrank the claim script's mkOptionDefault stack.slot.nix — only pin a slot the CC set
    if (m.slotOwned) lines.push(`  stack.slot = ${m.slot};`);
    if (m.osLayerCache.originHost) {
      lines.push(`  osLayerCache.originHost = ${nixStr(m.osLayerCache.originHost)};`);
    }
    for (const [k, v] of Object.entries(m.ports)) {
      if (isPortOverride(k, v, m.portDefaults)) lines.push(`  ports.${k} = ${v};`);
    }
    for (const [path, v] of Object.entries(m.options)) {
      lines.push(`  ${path} = ${typeof v === 'string' ? nixStr(v) : v};`);
    }
    if (m.fleetOwned && m.fleet) {
      const bmc = (m.fleet.defaults as { bmc?: unknown }).bmc;
      if (bmc && typeof bmc === 'object') lines.push(`  fleet.defaults.bmc = ${toNix(bmc, '  ')};`);
      for (const key of ['cpus', 'memory_mb', 'disk_gb'] as const) {
        const v = m.fleet?.defaults?.[key];
        if (typeof v === 'number' && Number.isFinite(v)) lines.push(`  fleet.defaults.${key} = ${v};`);
      }
      const arch = m.fleet.defaults?.arch;
      if (typeof arch === 'string' && arch) lines.push(`  fleet.defaults.arch = ${nixStr(arch)};`);
      for (const [key, v] of Object.entries(m.fleet.network)) {
        if (typeof v === 'string') lines.push(`  fleet.network.${key} = ${nixStr(v)};`);
        else if (typeof v === 'boolean') lines.push(`  fleet.network.${key} = ${v};`);
      }
      if (!isDefaultSingleZoneSet(m.zonesMeta)) {
        for (const zone of [...m.zonesMeta].sort((a, b) => a.index - b.index)) {
          lines.push(`  fleet.zones.${nixStr(zone.name)}.index = ${zone.index};`);
          lines.push(`  fleet.zones.${nixStr(zone.name)}.bridges = ${zone.bridges};`);
        }
      }
      for (const name of m.zoneTombstones) {
        lines.push(`  fleet.zones.${nixStr(name)}.enable = false;`);
      }
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
    const positive = (v: string | null | undefined, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const knobDefault = knobsFromCatalog('spoke', this.current().catalog, {}).find(
      (k) => k.env === 'LIFECYCLE_WORKER_CONCURRENCY',
    )?.default;
    const override = this.overrides().spoke.LIFECYCLE_WORKER_CONCURRENCY;
    return {
      counts: this.counts(),
      lifecycleWorkerConcurrency: positive(override, positive(knobDefault, 1)),
    };
  }
}
