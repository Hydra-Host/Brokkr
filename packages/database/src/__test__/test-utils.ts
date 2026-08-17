export const PG_UNIQUE_VIOLATION = '23505';

export function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? { ...v } : {};
}

export function extractPgErrorCode(error: unknown): string | null {
  const errObj = rec(error);
  const cause = rec(errObj.cause);
  return typeof cause.code === 'string' ? cause.code : typeof errObj.code === 'string' ? errObj.code : null;
}
