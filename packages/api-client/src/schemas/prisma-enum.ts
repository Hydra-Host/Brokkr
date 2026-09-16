import { z } from 'zod';

/** z.enum from Prisma enum values; throws if the enum object is empty. */
export function zodEnumFromPrisma<T extends Record<string, string>>(values: T) {
  const options = Object.values(values) as [T[keyof T], ...T[keyof T][]];
  if (options.length === 0) {
    throw new Error('zodEnumFromPrisma requires a non-empty enum');
  }
  return z.enum(options);
}
