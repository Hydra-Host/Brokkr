export function isPrimitive(val: unknown): boolean {
  return val != null && typeof val !== 'object';
}

export function isRecord(val: unknown): val is Record<string, unknown> {
  return val != null && typeof val === 'object' && !Array.isArray(val);
}

export function isRowArray(val: unknown): val is Record<string, unknown>[] {
  return Array.isArray(val) && val.length > 0 && isRecord(val[0]);
}
