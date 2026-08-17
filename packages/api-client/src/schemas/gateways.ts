import { z } from 'zod';

export const GatewayIpSummarySchema = z.object({
  id: z.string().uuid().describe('Gateway IP address UUID'),
  address: z.string().describe('Gateway IP address, optionally with a host mask (e.g. "10.0.1.2/24")'),
});
export type GatewayIpSummary = z.infer<typeof GatewayIpSummarySchema>;

export const GatewayPrefixSummarySchema = z.object({
  id: z.string().uuid().describe('Prefix UUID'),
  prefix: z.string().describe('CIDR network block of the prefix (e.g. "10.0.1.0/24")'),
});
export type GatewayPrefixSummary = z.infer<typeof GatewayPrefixSummarySchema>;

export const GatewayVrfSummarySchema = z.object({
  id: z.string().uuid().describe('VRF UUID'),
  name: z.string().describe('Human-readable name of the VRF'),
});
export type GatewayVrfSummary = z.infer<typeof GatewayVrfSummarySchema>;

export const GatewaySchema = z.object({
  id: z.string().uuid().describe('Gateway UUID'),
  routingPriority: z.number().int().nullable().describe('Gateway routing priority'),
  vrfId: z.string().uuid().nullable().describe('Associated VRF UUID'),
  gatewayIpId: z.string().uuid().describe('Gateway IP address UUID'),
  prefixId: z.string().uuid().describe('Associated prefix UUID'),
  gatewayIp: GatewayIpSummarySchema.describe('Summary of the IP address acting as the gateway'),
  prefix: GatewayPrefixSummarySchema.describe('Summary of the prefix this gateway serves'),
  vrf: GatewayVrfSummarySchema.nullable().describe(
    'Summary of the associated VRF, or null for the global routing table',
  ),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type Gateway = z.infer<typeof GatewaySchema>;

export const CreateGatewayRequestSchema = z.object({
  gatewayIpId: z.string().uuid().describe('Gateway IP address UUID'),
  prefixId: z.string().uuid().describe('Associated prefix UUID'),
  vrfId: z.string().uuid().nullable().optional().describe('Associated VRF UUID'),
  routingPriority: z.number().int().optional().describe('Gateway routing priority'),
});
export type CreateGatewayRequest = z.infer<typeof CreateGatewayRequestSchema>;

export const UpdateGatewayRequestSchema = z.object({
  gatewayIpId: z.string().uuid().optional().describe('Gateway IP address UUID'),
  prefixId: z.string().uuid().optional().describe('Associated prefix UUID'),
  vrfId: z.string().uuid().nullable().optional().describe('Associated VRF UUID'),
  routingPriority: z.number().int().nullable().optional().describe('Gateway routing priority'),
});
export type UpdateGatewayRequest = z.infer<typeof UpdateGatewayRequestSchema>;

export const GatewayListQuerySchema = z.object({
  vrfId: z.string().uuid().optional().describe('Filter by VRF UUID'),
  prefixId: z.string().uuid().optional().describe('Filter by prefix UUID'),
});
export type GatewayListQuery = z.infer<typeof GatewayListQuerySchema>;
