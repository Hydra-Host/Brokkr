import { statSync } from 'node:fs';

const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** A run's log file and results dir both exist for a moment before its row commits, so a fresh orphan
 *  is that race rather than garbage. Throws when the path cannot be stat'd. */
export function pastOrphanGrace(path: string, now: number): boolean {
  return now - statSync(path).mtimeMs >= ORPHAN_GRACE_MS;
}
