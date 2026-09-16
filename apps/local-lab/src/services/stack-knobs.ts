import { writableFor } from '@repo/local-lab-contract';
import { isRecord } from '@repo/utils';
import type { KnobCatalogEntry } from '../common/pc-schemas';
import type { StackConfig, StackKnob } from '../contract';
import { PORTS } from '../ports';

export type StackGroup = 'hub' | 'spoke';

/** Every knob path `config.envPins` holds, mapped to the variable holding it. */
export type EnvPins = Record<string, string>;

/** A catalog path must resolve in `config`, so an env knob is published under `stackDefaults.<g>.<KEY>`;
 *  the prefix is stripped here and never reaches a contract shape. */
const ENV_KNOB_ROOT = 'stackDefaults';

export const envKnobPath = (group: StackGroup, env: string): string => `${ENV_KNOB_ROOT}.${group}.${env}`;

const envKnobKey = (group: StackGroup, path: string): string | null => {
  const prefix = `${ENV_KNOB_ROOT}.${group}.`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
};

export const catalogByPath = (catalog: KnobCatalogEntry[]): Map<string, KnobCatalogEntry> =>
  new Map(catalog.map((entry) => [entry.path, entry]));

// `port` never reaches an env knob (those are string-typed); it rides along so a widened catalog still
// renders rather than falling off the map.
const KNOB_KINDS: Record<KnobCatalogEntry['kind'], StackKnob['kind']> = {
  bool: 'bool',
  number: 'number',
  port: 'number',
  select: 'select',
  text: 'text',
};

const isTcpPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

const catalogDefault = (entry: KnobCatalogEntry): string | null =>
  entry.default === null || entry.default === undefined ? null : String(entry.default);

/** Contract-shaped knobs for one group. A path the catalog omits cannot be rendered and cannot be
 *  saved — the catalog is the whole editable surface, not a starting point. */
export const knobsFromCatalog = (group: StackGroup, catalog: KnobCatalogEntry[], pins: EnvPins): StackKnob[] =>
  catalog.flatMap((entry) => {
    const env = envKnobKey(group, entry.path);
    if (env === null || !entry.editable) return [];
    const nixDefault = catalogDefault(entry);
    const pinnedBy = pins[entry.path];
    return [
      {
        path: entry.path,
        env,
        writable: writableFor(entry.path, entry.editable),
        label: entry.label,
        group: entry.group,
        kind: KNOB_KINDS[entry.kind],
        default: nixDefault,
        source: nixDefault === null ? 'lab' : 'nix',
        info: entry.description,
        ...(entry.choices.length > 0 ? { options: entry.choices } : {}),
        ...(entry.danger ? { danger: true } : {}),
        ...(pinnedBy ? { pinnedBy } : {}),
      },
    ];
  });

/** Pre-override value of every editable port the catalog declares — what `config.ports` is diffed
 *  against to decide which keys the overlay must pin. */
export const portDefaultsFromCatalog = (catalog: KnobCatalogEntry[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const entry of catalog) {
    if (!entry.path.startsWith('ports.')) continue;
    if (typeof entry.default !== 'number' || !isTcpPort(entry.default)) continue;
    out[entry.path.slice('ports.'.length)] = entry.default;
  }
  return out;
};

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

/** A slot-derived port is catalogued at `ports.<key>.base`, so a flat-only lookup drops it and
 *  servicePortRows silently renders one fewer row than the caller asked for. */
const portMeta = (key: string, catalog: Map<string, KnobCatalogEntry>): KnobCatalogEntry | undefined =>
  catalog.get(`ports.${key}`) ?? catalog.get(`ports.${key}.base`);

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

/** Every port Nix declares read-only, not a curated subset: the editor showed four of twenty and
 *  the other sixteen were catalogued but rendered on no page. */
export const readOnlyPortsFrom = (
  raw: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const key of keys) {
    // A slot-derived port arrives as `{ base }`, not a number, so reading the key alone drops it —
    // the same shape portMeta resolves at `ports.<key>.base`.
    const v = (raw ?? {})[key];
    const n = Number(isRecord(v) ? v.base : v);
    if (isTcpPort(n)) out[key] = n;
  }
  return out;
};

export const servicePortRows = (
  keys: readonly string[],
  values: Record<string, number>,
  readOnly: boolean,
  catalog: Map<string, KnobCatalogEntry>,
): StackConfig['servicePorts'] =>
  keys.flatMap((key) => {
    const value = values[key];
    const entry = portMeta(key, catalog);
    if (value === undefined || !entry) return [];
    return [
      {
        key,
        path: entry.path,
        group: entry.group,
        label: entry.label,
        value,
        info: entry.description,
        ...(readOnly ? { readOnly: true } : {}),
      },
    ];
  });

export const readOnlyPortRows = (
  keys: readonly string[],
  values: Record<string, number>,
  catalog: Map<string, KnobCatalogEntry>,
): StackConfig['servicePorts'] => servicePortRows(keys, values, true, catalog);

export const OBSERVABILITY_PROCS = ['otel-collector', 'tempo', 'loki', 'grafana'];
