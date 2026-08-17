import { isRecord } from '@repo/utils';

/** Python `bool()` semantics, for untyped boundaries only — typed dispatch data uses protocol schemas; don't reintroduce local copies. */
export function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === 0n || value === '') return false;
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (Array.isArray(value)) return value.length > 0;
  if (ArrayBuffer.isView(value)) return (value as { byteLength: number }).byteLength > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return Boolean(value);
}

export function pythonFalsy(value: unknown): boolean {
  return !pythonTruthy(value);
}
