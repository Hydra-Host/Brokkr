export function msToSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function msToMinutes(ms: number): number {
  return Math.floor(ms / (1000 * 60));
}

export function msToHours(ms: number): number {
  return Math.floor(ms / (1000 * 60 * 60));
}

export function msToDays(ms: number): number {
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function formatMilliseconds(ms: number): string {
  const days = msToDays(ms);
  const hours = msToHours(ms % (1000 * 60 * 60 * 24));
  const minutes = msToMinutes(ms % (1000 * 60 * 60));
  const seconds = msToSeconds(ms % (1000 * 60));

  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
  if (seconds > 0 && parts.length === 0) parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);

  return parts.join(' ');
}
