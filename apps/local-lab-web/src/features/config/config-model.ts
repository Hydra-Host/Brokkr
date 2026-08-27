import type { ConfigTreeEntry } from '@/contract';

import { configSource, isOverridden } from '@/lib/config-tree';
import { AREA_SECTIONS, knobLocation, type ConfigArea } from './knob-location';

export interface OverriddenRow {
  entry: ConfigTreeEntry;
  route: string;
  anchor: string;
  source: ReturnType<typeof configSource>;
}

export interface AreaOverrides {
  area: ConfigArea;
  rows: OverriddenRow[];
}

/** Every knob whose value differs from its declared default, grouped by the page that owns it. A path
 *  no editor owns is dropped here rather than shown with nowhere to go — /config/advanced lists it. */
export function overriddenByArea(entries: ConfigTreeEntry[]): AreaOverrides[] {
  const byArea = new Map<ConfigArea, OverriddenRow[]>();
  for (const entry of entries) {
    if (!isOverridden(entry)) continue;
    const where = knobLocation(entry.path);
    if (!where) continue;
    const bucket = byArea.get(where.area) ?? [];
    bucket.push({ entry, route: where.route, anchor: where.anchor, source: configSource(entry) });
    byArea.set(where.area, bucket);
  }
  const order: ConfigArea[] = ['stack', 'zones', 'fleet', 'advanced'];
  return order.filter((area) => byArea.has(area)).map((area) => ({ area, rows: byArea.get(area) ?? [] }));
}

export interface SourceCount {
  label: string;
  kind: ReturnType<typeof configSource>['kind'];
  count: number;
}

/** Which files and pins actually define something. A hand-edited devenv.local.nix shows up here and
 *  nowhere else, because the control center never writes that file and cannot offer to undo it. */
export function sourceSummary(entries: ConfigTreeEntry[]): SourceCount[] {
  const counts = new Map<string, SourceCount>();
  for (const entry of entries) {
    if (!isOverridden(entry)) continue;
    const source = configSource(entry);
    if (source.kind === 'default') continue;
    const seen = counts.get(source.label);
    if (seen) seen.count += 1;
    else counts.set(source.label, { label: source.label, kind: source.kind, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Rail dots. Every declared section is present, so a section that loses its last override keeps its
 *  place instead of the rail reflowing. */
export function changedBySection(entries: ConfigTreeEntry[], area: ConfigArea): { section: string; changed: number }[] {
  const counts = new Map<string, number>(AREA_SECTIONS[area].map((section) => [section, 0]));
  for (const entry of entries) {
    if (!isOverridden(entry)) continue;
    const where = knobLocation(entry.path);
    if (!where || where.area !== area) continue;
    counts.set(where.section, (counts.get(where.section) ?? 0) + 1);
  }
  return AREA_SECTIONS[area].map((section) => ({ section, changed: counts.get(section) ?? 0 }));
}

export const overriddenCount = (entries: ConfigTreeEntry[]): number => entries.filter(isOverridden).length;
