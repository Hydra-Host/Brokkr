import { z } from 'zod';

export const CircuitStatusSchema = z.enum(['ACTIVE', 'PLANNED', 'OFFLINE', 'DEPROVISIONING', 'DECOMMISSIONED']);
export type CircuitStatus = z.infer<typeof CircuitStatusSchema>;

export const CircuitTerminationSideSchema = z.enum(['A', 'Z']);
export type CircuitTerminationSide = z.infer<typeof CircuitTerminationSideSchema>;

export const ProviderSchema = z.object({
  id: z.string().uuid().describe('Provider UUID'),
  name: z.string().describe('Provider name'),
  slug: z.string().describe('Provider slug'),
  description: z.string().nullable().describe('Provider description'),
  comments: z.string().nullable().describe('Provider comments'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const CreateProviderRequestSchema = z.object({
  name: z.string().min(1).describe('Provider name'),
  slug: z.string().min(1).describe('Provider slug'),
  description: z.string().trim().optional().describe('Provider description'),
  comments: z.string().trim().optional().describe('Provider comments'),
});
export type CreateProviderRequest = z.infer<typeof CreateProviderRequestSchema>;

export const UpdateProviderRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Provider name'),
  slug: z.string().min(1).optional().describe('Provider slug'),
  description: z.string().trim().nullable().optional().describe('Provider description'),
  comments: z.string().trim().nullable().optional().describe('Provider comments'),
});
export type UpdateProviderRequest = z.infer<typeof UpdateProviderRequestSchema>;

export const ProviderListQuerySchema = z.object({
  search: z.string().trim().optional().describe('Search by provider name'),
});
export type ProviderListQuery = z.infer<typeof ProviderListQuerySchema>;

export const ProviderNetworkSchema = z.object({
  id: z.string().uuid().describe('Provider network UUID'),
  name: z.string().describe('Provider network name'),
  description: z.string().nullable().describe('Provider network description'),
  comments: z.string().nullable().describe('Provider network comments'),
  providerId: z.string().uuid().describe('Parent provider UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type ProviderNetwork = z.infer<typeof ProviderNetworkSchema>;

export const CreateProviderNetworkRequestSchema = z.object({
  name: z.string().min(1).describe('Provider network name'),
  description: z.string().trim().optional().describe('Provider network description'),
  comments: z.string().trim().optional().describe('Provider network comments'),
  providerId: z.string().uuid().describe('Parent provider UUID'),
});
export type CreateProviderNetworkRequest = z.infer<typeof CreateProviderNetworkRequestSchema>;

export const UpdateProviderNetworkRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Provider network name'),
  description: z.string().trim().nullable().optional().describe('Provider network description'),
  comments: z.string().trim().nullable().optional().describe('Provider network comments'),
});
export type UpdateProviderNetworkRequest = z.infer<typeof UpdateProviderNetworkRequestSchema>;

export const ProviderNetworkListQuerySchema = z.object({
  providerId: z.string().uuid().optional().describe('Filter by provider UUID'),
  search: z.string().trim().optional().describe('Search by provider network name'),
});
export type ProviderNetworkListQuery = z.infer<typeof ProviderNetworkListQuerySchema>;

export const CircuitTypeSchema = z.object({
  id: z.string().uuid().describe('Circuit type UUID'),
  name: z.string().describe('Circuit type name'),
  slug: z.string().describe('Circuit type slug'),
  color: z.string().nullable().describe('Circuit type display color (hex or named)'),
  description: z.string().nullable().describe('Circuit type description'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type CircuitType = z.infer<typeof CircuitTypeSchema>;

export const CreateCircuitTypeRequestSchema = z.object({
  name: z.string().min(1).describe('Circuit type name'),
  slug: z.string().min(1).describe('Circuit type slug'),
  color: z.string().trim().optional().describe('Circuit type display color (hex or named)'),
  description: z.string().trim().optional().describe('Circuit type description'),
});
export type CreateCircuitTypeRequest = z.infer<typeof CreateCircuitTypeRequestSchema>;

export const UpdateCircuitTypeRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Circuit type name'),
  slug: z.string().min(1).optional().describe('Circuit type slug'),
  color: z.string().trim().nullable().optional().describe('Circuit type display color (hex or named)'),
  description: z.string().trim().nullable().optional().describe('Circuit type description'),
});
export type UpdateCircuitTypeRequest = z.infer<typeof UpdateCircuitTypeRequestSchema>;

export const CircuitTypeListQuerySchema = z.object({
  search: z.string().trim().optional().describe('Search by circuit type name'),
});
export type CircuitTypeListQuery = z.infer<typeof CircuitTypeListQuerySchema>;

export const CircuitSchema = z.object({
  id: z.string().uuid().describe('Circuit UUID'),
  cid: z.string().describe('Circuit ID (unique circuit identifier)'),
  status: CircuitStatusSchema.describe('Circuit operational status'),
  installDate: z.coerce.date().nullable().describe('Circuit installation date'),
  terminationDate: z.coerce.date().nullable().describe('Circuit termination date'),
  commitRate: z.number().int().nullable().describe('Committed information rate in Kbps'),
  description: z.string().nullable().describe('Circuit description'),
  comments: z.string().nullable().describe('Circuit comments'),
  providerId: z.string().uuid().describe('Provider UUID'),
  circuitTypeId: z.string().uuid().describe('Circuit type UUID'),
  organizationId: z.string().uuid().nullable().describe('Owning organization UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type Circuit = z.infer<typeof CircuitSchema>;

export const CreateCircuitRequestSchema = z.object({
  cid: z.string().min(1).describe('Circuit ID (unique circuit identifier)'),
  status: CircuitStatusSchema.optional().describe('Circuit operational status'),
  installDate: z.coerce.date().optional().describe('Circuit installation date'),
  terminationDate: z.coerce.date().optional().describe('Circuit termination date'),
  commitRate: z.number().int().optional().describe('Committed information rate in Kbps'),
  description: z.string().trim().optional().describe('Circuit description'),
  comments: z.string().trim().optional().describe('Circuit comments'),
  providerId: z.string().uuid().describe('Provider UUID'),
  circuitTypeId: z.string().uuid().describe('Circuit type UUID'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type CreateCircuitRequest = z.infer<typeof CreateCircuitRequestSchema>;

export const UpdateCircuitRequestSchema = z.object({
  cid: z.string().min(1).optional().describe('Circuit ID (unique circuit identifier)'),
  status: CircuitStatusSchema.optional().describe('Circuit operational status'),
  installDate: z.coerce.date().nullable().optional().describe('Circuit installation date'),
  terminationDate: z.coerce.date().nullable().optional().describe('Circuit termination date'),
  commitRate: z.number().int().nullable().optional().describe('Committed information rate in Kbps'),
  description: z.string().trim().nullable().optional().describe('Circuit description'),
  comments: z.string().trim().nullable().optional().describe('Circuit comments'),
  providerId: z.string().uuid().optional().describe('Provider UUID'),
  circuitTypeId: z.string().uuid().optional().describe('Circuit type UUID'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type UpdateCircuitRequest = z.infer<typeof UpdateCircuitRequestSchema>;

export const CircuitListQuerySchema = z.object({
  providerId: z.string().uuid().optional().describe('Filter by provider UUID'),
  circuitTypeId: z.string().uuid().optional().describe('Filter by circuit type UUID'),
  organizationId: z.string().uuid().optional().describe('Filter by organization UUID'),
  status: CircuitStatusSchema.optional().describe('Filter by circuit status'),
  search: z.string().trim().optional().describe('Search by circuit ID'),
});
export type CircuitListQuery = z.infer<typeof CircuitListQuerySchema>;

export const CircuitTerminationSchema = z.object({
  id: z.string().uuid().describe('Circuit termination UUID'),
  termSide: CircuitTerminationSideSchema.describe('Termination side (A or Z)'),
  portSpeed: z.number().int().nullable().describe('Port speed in Kbps'),
  upstreamSpeed: z.number().int().nullable().describe('Upstream speed in Kbps'),
  xconnectId: z.string().nullable().describe('Cross-connect identifier'),
  description: z.string().nullable().describe('Circuit termination description'),
  circuitId: z.string().uuid().describe('Parent circuit UUID'),
  zoneId: z.string().uuid().nullable().describe('Associated zone UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type CircuitTermination = z.infer<typeof CircuitTerminationSchema>;

export const CreateCircuitTerminationRequestSchema = z.object({
  termSide: CircuitTerminationSideSchema.describe('Termination side (A or Z)'),
  portSpeed: z.number().int().optional().describe('Port speed in Kbps'),
  upstreamSpeed: z.number().int().optional().describe('Upstream speed in Kbps'),
  xconnectId: z.string().trim().optional().describe('Cross-connect identifier'),
  description: z.string().trim().optional().describe('Circuit termination description'),
  circuitId: z.string().uuid().describe('Parent circuit UUID'),
  zoneId: z.string().uuid().nullable().optional().describe('Associated zone UUID'),
});
export type CreateCircuitTerminationRequest = z.infer<typeof CreateCircuitTerminationRequestSchema>;

export const UpdateCircuitTerminationRequestSchema = z.object({
  termSide: CircuitTerminationSideSchema.optional().describe('Termination side (A or Z)'),
  portSpeed: z.number().int().nullable().optional().describe('Port speed in Kbps'),
  upstreamSpeed: z.number().int().nullable().optional().describe('Upstream speed in Kbps'),
  xconnectId: z.string().trim().nullable().optional().describe('Cross-connect identifier'),
  description: z.string().trim().nullable().optional().describe('Circuit termination description'),
  zoneId: z.string().uuid().nullable().optional().describe('Associated zone UUID'),
});
export type UpdateCircuitTerminationRequest = z.infer<typeof UpdateCircuitTerminationRequestSchema>;

export const CircuitTerminationListQuerySchema = z.object({
  circuitId: z.string().uuid().optional().describe('Filter by circuit UUID'),
  zoneId: z.string().uuid().optional().describe('Filter by zone UUID'),
  search: z.string().trim().optional().describe('Search by cross-connect ID or description'),
});
export type CircuitTerminationListQuery = z.infer<typeof CircuitTerminationListQuerySchema>;
