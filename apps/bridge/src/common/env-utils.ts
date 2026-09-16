import { z } from 'zod';

// python int() grammar, so the same value parses on both bridges
export const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

export const envInt = (def: number) =>
  z
    .union([z.string(), z.undefined()])
    .transform((value, ctx) => {
      if (value === undefined) return def;
      if (!STRICT_INT_PATTERN.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid integer: ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      return Number.parseInt(value.replace(/_/g, ''), 10);
    })
    .pipe(z.number().int());
