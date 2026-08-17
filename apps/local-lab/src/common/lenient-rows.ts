import type { z } from 'zod';

export interface LenientRead<T> {
  rows: T[];
  skipped: number;
}

// per-row rather than all-or-nothing: one row this build cannot read — written by a newer lab, or a
// column a migration changed — must not fail the whole read, and a short list must be countable.
export function readRows<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raws: unknown[]): LenientRead<T> {
  const rows: T[] = [];
  let skipped = 0;
  for (const raw of raws) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) rows.push(parsed.data);
    else skipped += 1;
  }
  return { rows, skipped };
}
