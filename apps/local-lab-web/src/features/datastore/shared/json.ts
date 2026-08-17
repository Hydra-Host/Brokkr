export function isJsonLike(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
