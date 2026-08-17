import { Logger } from '@nestjs/common';

import type { StackConfig, StackKnob } from '../contract';
import { HOSTS, PORTS, URLS } from '../ports';

export type StackGroup = 'hub' | 'spoke';

const log = new Logger('StackKnobs');

/** Pre-override env maps published by the Nix layer (`devenv eval stackDefaults`); `hubKnobEnv` remaps
 *  the hub knobs whose control-center name is not itself an env key. */
export type StackDefaults = {
  hub: Record<string, string>;
  spoke: Record<string, string>;
  hubKnobEnv: Record<string, string[]>;
};

export const emptyStackDefaults = (): StackDefaults => ({ hub: {}, spoke: {}, hubKnobEnv: {} });

/** Where a knob's default comes from, declared so the exceptions can't hide: `nix` = stackDefaults (via
 *  hubKnobEnv where remapped), `derived` = recomputed in stackConfig(), `lab` = Nix has no key for it. */
export type KnobDefaultSource = 'nix' | 'derived' | 'lab';
type LabStackKnob = StackKnob & { nixDefault: KnobDefaultSource };

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
export const STACK_KNOBS: { hub: LabStackKnob[]; spoke: LabStackKnob[] } = {
  hub: [
    {
      group: 'Location',
      env: 'HUB_REPO_PATH',
      label: 'Hub repo path',
      default: '',
      nixDefault: 'lab',
      kind: 'text',
      info: 'Absolute path to the hub checkout on this host. The control center launches the hub (api/web) from here — required; the hub cannot start without a valid path.',
    },
    // HH_ENV and LOCAL_SIMULATION_ENABLED are deliberately NOT knobs — changing them breaks the stack; modules/hub.nix pins them.
    {
      group: 'Security',
      env: 'AUTH_BYPASS_ENABLED',
      label: 'Auth bypass',
      default: 'true',
      nixDefault: 'nix',
      kind: 'bool',
      danger: true,
      info: 'Relaxes auth SSO + Entra link + CSRF/origin + password length + seeds the local brokkr Owner. ON in sim; toggle OFF to exercise the production auth path locally. Gated by HH_ENV ∈ AUTH_BYPASS_ALLOWED_ENVS — never honored in prod.',
    },
    {
      group: 'Logging',
      env: 'LOG_LEVEL',
      label: 'Log level',
      default: 'debug',
      nixDefault: 'nix',
      kind: 'select',
      options: LOG_LEVELS,
    },
    {
      group: 'Datastores',
      env: 'DATABASE_URL',
      label: 'Postgres URL',
      default: '',
      nixDefault: 'derived',
      kind: 'text',
    },
    { group: 'Datastores', env: 'REDIS_URL', label: 'Redis URL', default: URLS.redis, nixDefault: 'nix', kind: 'text' },
    { group: 'URLs', env: 'BASE_URL', label: 'Base URL', default: URLS.hubBase, nixDefault: 'nix', kind: 'text' },
  ],
  spoke: [
    // LOCAL_SIMULATION_ENABLED is deliberately NOT a knob — toggling it off breaks the spoke's sim-mode wiring; the shim pins it.
    {
      group: 'Logging',
      env: 'LOG_LEVEL',
      label: 'Log level',
      default: 'debug',
      nixDefault: 'nix',
      kind: 'select',
      options: LOG_LEVELS,
    },
    {
      group: 'Logging',
      env: 'LOG_FORMAT',
      label: 'Log format',
      default: 'console',
      nixDefault: 'nix',
      kind: 'select',
      options: ['console', 'json'],
    },
    {
      group: 'Logging',
      env: 'MONITORING_LOGS_ENABLED',
      label: 'Monitoring logs',
      default: 'false',
      nixDefault: 'nix',
      kind: 'bool',
    },
    {
      group: 'Monitoring',
      env: 'TELEGRAF_ENABLED',
      label: 'Telegraf telemetry',
      default: 'true',
      nixDefault: 'nix',
      kind: 'bool',
      info: 'Per-bridge telegraf agent: scrapes device metrics (ICMP/IPMI/Redfish + PDU SNMP) via the bridge and remote_writes to the local Thanos. OFF removes the telegraf process and leaves the bridge config-writer inert.',
    },
    {
      group: 'Workers',
      env: 'LIFECYCLE_WORKER_CONCURRENCY',
      label: 'Lifecycle concurrency',
      default: '10',
      nixDefault: 'nix',
      kind: 'number',
    },
    {
      group: 'Workers',
      env: 'COLLECTION_WORKER_CONCURRENCY',
      label: 'Collection concurrency',
      default: '1',
      nixDefault: 'nix',
      kind: 'number',
    },
    {
      group: 'Boot/cache',
      env: 'OS_LAYER_URL',
      label: 'OS layer URL',
      default: URLS.osLayer,
      nixDefault: 'nix',
      kind: 'text',
    },
    {
      group: 'Boot/cache',
      env: 'DISCOVERY_BASE_URL',
      label: 'Discovery/ISO base URL',
      default: HOSTS.assetOrigin ? `https://${HOSTS.assetOrigin}/brokkr-live-light` : '',
      nixDefault: 'derived',
      kind: 'text',
    },
    {
      group: 'Boot/cache',
      env: 'BROKKR_LIVE_VERSION',
      label: 'brokkr-live (ISO) version',
      default: '1.1.8',
      nixDefault: 'nix',
      kind: 'text',
    },
    {
      group: 'ISO download',
      env: 'BRIDGE_SYNC_ENABLED',
      label: 'Sync/update ISO on boot',
      default: 'true',
      nixDefault: 'nix',
      kind: 'bool',
    },
    {
      group: 'ISO download',
      env: 'HTTPS_DOWNLOAD_TIMEOUT',
      label: 'Download timeout (s)',
      default: '3600',
      nixDefault: 'nix',
      kind: 'number',
    },
    {
      group: 'ISO download',
      env: 'HTTPS_RETRY_ATTEMPTS',
      label: 'Retry attempts',
      default: '3',
      nixDefault: 'nix',
      kind: 'number',
    },
    {
      group: 'ISO download',
      env: 'HTTPS_RETRY_DELAY',
      label: 'Retry delay (s)',
      default: '5',
      nixDefault: 'nix',
      kind: 'number',
    },
    {
      group: 'ISO download',
      env: 'HTTPS_VERIFY_SSL',
      label: 'Verify SSL',
      default: 'true',
      nixDefault: 'nix',
      kind: 'bool',
    },
    {
      group: 'Behavior',
      env: 'AGENT_SSH_FORCE_REDEPLOY',
      label: 'Force agent redeploy',
      default: 'true',
      nixDefault: 'nix',
      kind: 'bool',
    },
    {
      group: 'Behavior',
      env: 'ANALYTICS_ENABLED',
      label: 'Analytics',
      default: 'false',
      nixDefault: 'nix',
      kind: 'bool',
    },
  ],
};

/** The env keys Nix writes for a knob, in the order the remap emits them. */
export const knobEnvKeys = (knob: string, remap: Record<string, string[]>): string[] => remap[knob] ?? [knob];

const remapFor = (group: StackGroup, defaults: StackDefaults): Record<string, string[]> =>
  group === 'hub' ? defaults.hubKnobEnv : {};

export const knobNixDefault = (knob: LabStackKnob, group: StackGroup, defaults: StackDefaults): string | undefined => {
  if (knob.nixDefault === 'lab') return undefined;
  const env = defaults[group];
  return knobEnvKeys(knob.env, remapFor(group, defaults))
    .map((key) => env[key])
    .find((value) => value !== undefined);
};

const stripSource = (entry: LabStackKnob): StackKnob => {
  const { nixDefault, ...knob } = entry;
  void nixDefault;
  return knob;
};

/** Knobs with the pre-override Nix value substituted in. The declared literal is the fallback and is
 *  never replaced, so an unseeded mirror (empty maps) leaves every knob on it. */
export const resolvedKnobs = (group: StackGroup, defaults: StackDefaults): StackKnob[] =>
  STACK_KNOBS[group].map((entry) => {
    const resolved = knobNixDefault(entry, group, defaults);
    const knob = stripSource(entry);
    return resolved === undefined ? knob : { ...knob, default: resolved };
  });

export const STACK_PORTS: StackConfig['ports'] = {
  hub: [
    {
      label: 'API',
      value: String(PORTS.hubApi.base),
      note: `hub i → ${PORTS.hubApi.base}+${PORTS.hubApi.step}i (HUB_PORT)`,
    },
    { label: 'Web', value: String(PORTS.hubWeb), note: 'primary hub only' },
  ],
  spoke: [
    {
      label: 'HTTP',
      value: String(PORTS.spoke.base),
      note: `spoke i → ${PORTS.spoke.base}+${PORTS.spoke.step}i (PORT)`,
    },
    {
      label: 'gRPC',
      value: String(PORTS.spokeGrpc.base),
      note: `spoke i → ${PORTS.spokeGrpc.base}+${PORTS.spokeGrpc.step}i`,
    },
  ],
};

/** UI copy for a `config.ports` key — Nix owns the key set and the values, only the wording is ours.
 *  A key with no entry here still renders, under its raw key. */
const PORT_LABELS: Record<string, { label: string; info?: string }> = {
  nginx: { label: 'OS-layer cache (nginx)' },
  mailpitSmtp: { label: 'Mailpit SMTP', info: "Where local outbound mail is caught (the hub's SMTP_PORT)." },
  mailpitWeb: { label: 'Mailpit web UI' },
  postgres: { label: 'Postgres', info: 'Port change needs only a restart — the datadir persists.' },
  redis: { label: 'Redis' },
  redfish: {
    label: 'Redfish (sushy)',
    info: 'Read by the sim BMC daemons at startup — applies on the next fleet rebuild, not a live restart.',
  },
  thanosHttp: { label: 'Thanos HTTP' },
  thanosGrpc: { label: 'Thanos gRPC' },
  thanosRemoteWrite: { label: 'Thanos remote-write' },
  grafana: { label: 'Grafana UI' },
  otlpHttp: { label: 'OTLP HTTP (collector)' },
  otlpGrpc: { label: 'OTLP gRPC (collector)' },
  tempoHttp: { label: 'Tempo query' },
};

const warnedUnlabelledPorts = new Set<string>();
const portMeta = (key: string): { label: string; info?: string } => {
  const meta = PORT_LABELS[key];
  if (meta) return meta;
  if (!warnedUnlabelledPorts.has(key)) {
    warnedUnlabelledPorts.add(key);
    log.warn(`config.ports key "${key}" has no control-center label — rendering it under its raw key`);
  }
  return { label: key };
};

const isTcpPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/** Coerce a port map to the keys Nix declares editable. An unusable value falls back to `fallback`, and
 *  to nothing when that has no entry either — inventing a port number is the drift this reads Nix to avoid. */
export const editablePortsFrom = (
  raw: Record<string, unknown> | undefined,
  keys: readonly string[],
  fallback: Record<string, number> = {},
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const key of keys) {
    const n = Number((raw ?? {})[key]);
    if (isTcpPort(n)) out[key] = n;
    else if (fallback[key] !== undefined) out[key] = fallback[key];
  }
  return out;
};

/** A curated subset of `portGroups.readOnly`: the rest of that group is the control center's own ports
 *  and the hub/spoke replica math, both surfaced elsewhere. */
export const OBSERVABILITY_PORT_KEYS = ['grafana', 'otlpHttp', 'otlpGrpc', 'tempoHttp'] as const;

const warnedMissingReadOnly = new Set<string>();
export const observabilityPortsFrom = (
  raw: Record<string, unknown> | undefined,
  readOnlyKeys: readonly string[],
): Record<string, number> => {
  const declared = new Set(readOnlyKeys);
  const out: Record<string, number> = {};
  for (const key of OBSERVABILITY_PORT_KEYS) {
    if (declared.size > 0 && !declared.has(key) && !warnedMissingReadOnly.has(key)) {
      warnedMissingReadOnly.add(key);
      log.warn(`observability port "${key}" is no longer in portGroups.readOnly — drop or rename the curated row`);
    }
    const n = Number((raw ?? {})[key]);
    if (isTcpPort(n)) out[key] = n;
  }
  return out;
};

export const servicePortRows = (
  keys: readonly string[],
  values: Record<string, number>,
  readOnly: boolean,
): StackConfig['servicePorts'] =>
  keys.flatMap((key) => {
    const value = values[key];
    if (value === undefined) return [];
    const { label, info } = portMeta(key);
    return [{ key, label, value, info, ...(readOnly ? { readOnly: true } : {}) }];
  });

export const OBSERVABILITY_PROCS = ['otel-collector', 'tempo', 'grafana'];
