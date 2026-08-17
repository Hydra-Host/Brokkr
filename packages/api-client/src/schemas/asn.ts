import { z } from 'zod';

export const AsnSchema = z.object({
  id: z.string().uuid().describe('ASN record UUID'),
  asn: z.number().int().describe('Autonomous System Number'),
  description: z.string().nullable().describe('ASN description'),
  organizationId: z.string().uuid().nullable().describe('Owning organization UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type Asn = z.infer<typeof AsnSchema>;

const ASN_MAX = 2147483647;

export const CreateAsnRequestSchema = z.object({
  asn: z.number().int().min(1).max(ASN_MAX).describe('Autonomous System Number'),
  description: z.string().trim().nullable().optional().describe('ASN description'),
});
export type CreateAsnRequest = z.infer<typeof CreateAsnRequestSchema>;

export const UpdateAsnRequestSchema = z.object({
  asn: z.number().int().min(1).max(ASN_MAX).optional().describe('Autonomous System Number'),
  description: z.string().trim().nullable().optional().describe('ASN description'),
});
export type UpdateAsnRequest = z.infer<typeof UpdateAsnRequestSchema>;

export const AsnListQuerySchema = z.object({
  organizationId: z.string().uuid().optional().describe('Filter by organization UUID'),
});
export type AsnListQuery = z.infer<typeof AsnListQuerySchema>;
