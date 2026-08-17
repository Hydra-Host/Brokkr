import { z } from 'zod';

const GARBAGE_SUBSTRINGS = ['to be filled', 'default string', 'not specified', 'chassis asset tag'];
const GARBAGE_EXACT = new Set(['unknown', 'na', 'n/a', 'none', '0', '00000000']);

export function hardwareString() {
  return z
    .string()
    .nullish()
    .transform((raw): string | null => {
      if (raw == null) return null;
      const trimmed = raw.trim();
      if (trimmed.length === 0) return null;
      const lower = trimmed.toLowerCase();
      if (GARBAGE_EXACT.has(lower)) return null;
      for (const fragment of GARBAGE_SUBSTRINGS) {
        if (lower.includes(fragment)) return null;
      }
      return trimmed;
    });
}
