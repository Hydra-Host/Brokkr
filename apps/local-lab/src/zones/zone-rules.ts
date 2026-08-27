import {
  RESERVED_ZONE_NAME,
  ZONE_INDEX_MAX,
  ZONE_INDEX_MIN,
  ZONE_NAME_RE,
  type ZoneWrite,
} from '@repo/local-lab-contract';

export interface ZoneRulesInput {
  desired: ZoneWrite[];
  declared: { name: string; index: number; bridges: number }[];
  nodeZones: Record<string, string>;
  nodesByZone: Record<string, string[]>;
  rename?: { from: string; to: string };
  capacity: number;
  hubZoneNames: string[];
}

/** The process name modules/spoke.nix derives for bridge `b` of a zone. Zone 0 keeps the bare `spoke`
 *  for back-compat, so a zone named `2` collides with replica 1 of zone 0. */
export const procNameOf = (zone: { name: string; index: number }, b: number): string =>
  zone.index === 0 ? (b === 0 ? 'spoke' : `spoke-${b}`) : `spoke-${zone.name}${b > 0 ? `-${b}` : ''}`;

const derivedProcNames = (zones: ZoneWrite[]): string[] =>
  zones.flatMap((z) => Array.from({ length: z.bridges }, (_, b) => procNameOf(z, b)));

const firstDuplicate = <T>(values: T[]): T | undefined => {
  const seen = new Set<T>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return undefined;
};

/** Every rule the engine enforces when it loads a fleet, plus the ones only the control center can see.
 *  Returns the first refusal so the caller reports one cause rather than a list to triage. */
export function zoneRefusal(input: ZoneRulesInput): string | null {
  const { desired, declared, nodeZones, nodesByZone, rename, capacity, hubZoneNames } = input;
  const names = desired.map((z) => z.name);

  const malformed = desired.find((z) => !ZONE_NAME_RE.test(z.name));
  if (malformed) {
    return `zone ${malformed.name}: a name must match ${ZONE_NAME_RE.source} — it becomes a token filename, the redis acl password and a process-compose process name`;
  }

  const dupName = firstDuplicate(names);
  if (dupName !== undefined) return `duplicate zone name: ${dupName}`;
  const dupIndex = firstDuplicate(desired.map((z) => z.index));
  if (dupIndex !== undefined) return `duplicate zone index: ${dupIndex}`;

  const outOfRange = desired.find((z) => z.index < ZONE_INDEX_MIN || z.index > ZONE_INDEX_MAX);
  if (outOfRange) {
    return `zone ${outOfRange.name}: index ${outOfRange.index} is outside ${ZONE_INDEX_MIN}..${ZONE_INDEX_MAX}, which is the range the zone uuid derivation covers`;
  }

  const reserved = names.find((name) => name === RESERVED_ZONE_NAME);
  if (reserved !== undefined) {
    return `${reserved} is seeded as a hub fixture, so a fleet zone taking the name makes the redis acl seeder's name lookup ambiguous`;
  }

  const collision = firstDuplicate(derivedProcNames(desired));
  if (collision !== undefined) {
    return `two bridges would both be called ${collision}; process-compose names must be unique and the name is also the bridge's leader-election identity`;
  }

  const used = desired.reduce((n, z) => n + z.bridges, 0);
  if (capacity > 0 && used > capacity) {
    return `${used} bridges exceed the ${capacity} ordinals available before the spoke port band walks into its neighbour`;
  }

  if (desired.length === 0) return 'a fleet needs at least one zone';

  const removed = declared.filter((z) => !names.includes(z.name)).map((z) => z.name);
  const renamedAway = rename ? [rename.from] : [];
  for (const name of removed) {
    if (renamedAway.includes(name)) continue;
    const owned = nodesByZone[name] ?? [];
    if (owned.length > 0) {
      return `zone ${name} still owns ${owned.length} node(s) (${owned.join(', ')}); move them before removing it`;
    }
  }

  if (rename) {
    const before = declared.find((z) => z.name === rename.from);
    const after = desired.find((z) => z.name === rename.to);
    if (!before) return `cannot rename ${rename.from}: no zone by that name is declared`;
    if (!after) return `a rename to ${rename.to} must also declare it in the zone set`;
    if (before.index !== after.index) {
      return `renaming ${rename.from} and moving its index in one save is refused: the index moves the zone uuid while the seeder matches on the name, so neither side can tell a rename from a new zone — do them as two saves`;
    }
    const clash = hubZoneNames.filter((n) => n === rename.to).length;
    if (clash > 0) {
      return `the hub already has a Zone row named ${rename.to}, and Zone.name carries no unique index, so the acl seeder would provision onto an arbitrary row`;
    }
  }

  const multi = desired.length > 1;
  for (const [node, zone] of Object.entries(nodeZones)) {
    if (!names.includes(zone)) return `node ${node}: zone ${zone} is not a declared zone (${names.join(', ')})`;
  }
  if (multi) {
    const unassigned = Object.values(nodesByZone)
      .flat()
      .filter((node) => nodeZones[node] === undefined);
    if (unassigned.length > 0) {
      return `every node must name a zone once two or more are declared; ${unassigned.length} node(s) have none (${unassigned.join(', ')})`;
    }
  }
  return null;
}
