import { RackFace } from '@repo/database/enums';
import { z } from 'zod';
import { zodEnumFromPrisma } from './prisma-enum';

export const RackElevationUnitSchema = z.object({
  unit: z.number().describe('Rack unit number'),
  face: zodEnumFromPrisma(RackFace).describe('Rack face'),
  occupied: z.boolean().describe('Whether this unit is occupied'),
  device: z
    .object({
      id: z.string().uuid().describe('Device UUID'),
      name: z.string().describe('Device name'),
      heightU: z.number().int().describe('Device height in rack units'),
      position: z.number().describe('Device position in rack'),
    })
    .nullable()
    .describe('Device occupying this unit, if any'),
});
export type RackElevationUnit = z.infer<typeof RackElevationUnitSchema>;

export const RackElevationQuerySchema = z.object({
  face: zodEnumFromPrisma(RackFace).optional().describe('Filter by rack face'),
});
export type RackElevationQuery = z.infer<typeof RackElevationQuerySchema>;
