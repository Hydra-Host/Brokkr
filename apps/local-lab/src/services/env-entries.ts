export function parseEnvEntries(entries: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq > 0) out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

export function stripQuoted(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}
