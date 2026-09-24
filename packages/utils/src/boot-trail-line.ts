import type { BootTrailInput } from './boot-trail-findings';

const clock = (ms: number): string => new Date(ms).toLocaleTimeString();
const chain = (atMs: number | null): string =>
  atMs === null ? 'iPXE chain reached' : `iPXE chain reached at ${clock(atMs)}`;

export function bootTrailLine(trail: BootTrailInput): string {
  if (trail.readError !== null) return `boot trail unreadable: ${trail.readError}`;
  if (trail.pxe === null) {
    return trail.chainReached === true
      ? `${chain(trail.chainAtMs)}, no PXE request recorded`
      : 'no PXE request seen yet';
  }
  const pxe = `PXE ${trail.pxe.outcome} at ${clock(trail.pxe.atMs)}`;
  return trail.chainReached === true ? `${pxe}; ${chain(trail.chainAtMs)}` : `${pxe}; iPXE chain not reached yet`;
}
