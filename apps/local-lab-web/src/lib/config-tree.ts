import type { ConfigTreeEntry } from '@/contract';

export type ConfigSourceKind = 'pin' | 'file' | 'default';
export type ConfigSource = { label: string; kind: ConfigSourceKind; title: string };

/** The overlay files an operator writes by hand. Every other definition site is a module declaration,
 *  so a row none of these define is showing the value the module declared. */
const OVERRIDE_FILES = new Set(['stack.local.nix', 'devenv.local.nix', '.env']);

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The server answers this: it holds both real values, and compares digests for a secret. A null is
 *  "cannot be told apart" and must not count as overridden. */
export const isOverridden = (entry: ConfigTreeEntry): boolean => entry.overridden === true;

export const overriddenState = (entry: ConfigTreeEntry): boolean | null => entry.overridden;

/** `definedIn` is ordered weakest-first by the module system, so the last overlay file listed is the
 *  one whose definition won. */
export function configSource(entry: ConfigTreeEntry): ConfigSource {
  if (entry.pinnedBy) {
    return {
      label: `$${entry.pinnedBy}`,
      kind: 'pin',
      title: `held by the ${entry.pinnedBy} environment variable, which outranks the overlay`,
    };
  }
  const sites = entry.definedIn.join(' → ');
  const file = [...entry.definedIn].reverse().find((f) => OVERRIDE_FILES.has(basename(f)));
  if (file) return { label: basename(file), kind: 'file', title: sites };
  return { label: 'default', kind: 'default', title: sites || 'no definition site reported' };
}

export const matchesConfigQuery = (entry: ConfigTreeEntry, query: string): boolean =>
  `${entry.path}=${entry.value}`.toLowerCase().includes(query.trim().toLowerCase());

export function filterConfigEntries(
  entries: ConfigTreeEntry[],
  { query, showAll }: { query: string; showAll: boolean },
): ConfigTreeEntry[] {
  return entries.filter((entry) => (showAll || isOverridden(entry)) && matchesConfigQuery(entry, query));
}

export function groupConfigEntries(entries: ConfigTreeEntry[]): { group: string; entries: ConfigTreeEntry[] }[] {
  const byGroup = new Map<string, ConfigTreeEntry[]>();
  for (const entry of entries) {
    const bucket = byGroup.get(entry.group);
    if (bucket) bucket.push(entry);
    else byGroup.set(entry.group, [entry]);
  }
  return [...byGroup].map(([group, groupEntries]) => ({ group, entries: groupEntries }));
}

/** An environment pin outranks the overlay, so a write here would answer ok and change nothing. */
export const isLocked = (entry: ConfigTreeEntry): boolean => Boolean(entry.pinnedBy);

export interface FieldProvenance {
  path: string;
  source: ConfigSource;
  /** Null means undetermined, which is what a masked secret leaves. */
  overridden: boolean | null;
  locked: boolean;
  lockReason: string | null;
  secret: boolean;
  /** What reverting lands on. Null when Nix declares no value, so there is nothing to revert to. */
  revertTo: string | null;
  value: string | null;
  label: string;
  description: string;
}

/** Everything one field needs to describe itself, from the one entry the config model already carries.
 *  A path the model does not declare returns null: the field still renders, and says so. */
export function fieldProvenance(entry: ConfigTreeEntry | undefined): FieldProvenance | null {
  if (!entry) return null;
  return {
    path: entry.path,
    source: configSource(entry),
    overridden: entry.overridden,
    locked: isLocked(entry),
    lockReason: entry.pinnedBy ? `unset ${entry.pinnedBy} to edit this here` : null,
    secret: entry.secret,
    revertTo: entry.default === '' ? null : entry.default,
    value: entry.value,
    label: entry.label,
    description: entry.description,
  };
}
