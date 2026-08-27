import { applyClassFor } from './apply-class';

/** A writer can persist this path. Derived from the writer rather than from the catalog's `editable`,
 *  because `stack.slot` is declared non-editable and setStackSlot writes it anyway. */
export function writableFor(path: string, editable: boolean): boolean {
  if (path === 'stack.slot') return true;
  if (path.startsWith('stackCounts.')) return false;
  return editable;
}

/** Knobs a save can reach that no rule prices. The config-reference generator refuses a live catalog
 *  holding any, which is what gates a newly declared knob rather than a hand-kept fixture. */
export const unclassifiedWritableKnobs = (catalog: readonly { path: string; editable: boolean }[]): string[] =>
  catalog.filter((k) => writableFor(k.path, k.editable) && applyClassFor(k.path) === null).map((k) => k.path);
