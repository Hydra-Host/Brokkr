export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i < units.length - 1 && Number(v.toFixed(1)) >= 1024) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

/** Relative age for a unix-ms stamp. Callers must decide null themselves: an unknown stamp and a
 *  never-seen one are different answers, and only the caller knows which it holds. */
export function fmtAgo(atMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  return `${fmtSpan(seconds)} ago`;
}

/** Signed counterpart for a stamp that may be in the future — a deadline, not an age. `fmtAgo`
 *  clamps the future to zero, which would report every live watchdog as having just fired. */
export function fmtDeadline(atMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.round((atMs - nowMs) / 1000);
  return seconds >= 0 ? `in ${fmtSpan(seconds)}` : `${fmtSpan(-seconds)} overdue`;
}

function fmtSpan(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
