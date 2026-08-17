import { z } from 'zod';

const envelopeIdSchema = z.union([z.string(), z.number()]).optional().catch(undefined);

export type EnvelopeId = string | number | undefined;

export function coerceEnvelopeId(value: unknown): EnvelopeId {
  return envelopeIdSchema.parse(value);
}

export function hasEnvelopeId(id: EnvelopeId): id is string | number {
  return id !== undefined && id !== '' && id !== 0;
}

export const jsonFlagSchema = z
  .unknown()
  .transform((value) => {
    if (value === null || value === undefined || value === false) return false;
    if (value === 0 || value === '') return false;
    if (typeof value === 'number') return !Number.isNaN(value);
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value as object).length > 0;
    return Boolean(value);
  })
  .pipe(z.boolean());

export function jsonFlag(value: unknown): boolean {
  return jsonFlagSchema.parse(value);
}
