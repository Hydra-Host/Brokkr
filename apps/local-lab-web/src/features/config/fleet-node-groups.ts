export interface ZoneGroup<T> {
  zone: string;
  items: T[];
  /** True when nothing declares this zone, so the group is drift rather than a section. */
  undeclared: boolean;
}

/** Declared zones keep their render order and appear even when empty, so an empty zone is visible
 *  rather than absent. A zone nothing declares sorts last and is flagged, never dropped. */
export function groupByZone<T>(items: T[], zoneOf: (item: T) => string, declared: string[]): ZoneGroup<T>[] {
  const declaredSet = new Set(declared);
  const groups = declared.map((zone) => ({
    zone,
    items: items.filter((item) => zoneOf(item) === zone),
    undeclared: false,
  }));
  const strays = [...new Set(items.map(zoneOf).filter((zone) => !declaredSet.has(zone)))].sort();
  return [
    ...groups,
    ...strays.map((zone) => ({ zone, items: items.filter((item) => zoneOf(item) === zone), undeclared: true })),
  ];
}
