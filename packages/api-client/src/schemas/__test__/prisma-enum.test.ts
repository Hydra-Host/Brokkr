import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodEnumFromPrisma } from '../prisma-enum';

const Sample = { FLAT: 'FLAT', VPC: 'VPC' } as const;

describe('zodEnumFromPrisma', () => {
  it('builds a z.enum with .options from the Prisma value object', () => {
    const schema = zodEnumFromPrisma(Sample);
    expect(schema.options).toEqual(['FLAT', 'VPC']);
    expect(schema.parse('VPC')).toBe('VPC');
    expect(schema.safeParse('VLAN').success).toBe(false);
  });

  it('is a ZodEnum, not a ZodNativeEnum', () => {
    const schema = zodEnumFromPrisma(Sample);
    expect(schema).toBeInstanceOf(z.ZodEnum);
  });

  it('throws when given an empty enum object', () => {
    expect(() => zodEnumFromPrisma({})).toThrow(/zodEnumFromPrisma requires a non-empty enum/);
  });
});
