export function parseTestDurationMinutes(durationStr: string): number {
  try {
    const s = durationStr.trim();
    if (s.endsWith('m')) return parseIntStrict(s.slice(0, -1));
    if (s.endsWith('h')) return parseIntStrict(s.slice(0, -1)) * 60;
    if (s.endsWith('d')) return parseIntStrict(s.slice(0, -1)) * 60 * 24;
    return parseIntStrict(s);
  } catch {
    return 30;
  }
}

function parseIntStrict(s: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`not an integer: ${s}`);
  return Number.parseInt(s, 10);
}
