import { z } from 'zod';

export const BgpSessionStatusSchema = z.enum(['ACTIVE', 'PLANNED', 'OFFLINE', 'DECOMMISSIONING']);
export type BgpSessionStatus = z.infer<typeof BgpSessionStatusSchema>;

export const BgpPeerGroupSchema = z.object({
  id: z.string().uuid().describe('BGP peer group UUID'),
  name: z.string().describe('Peer group name'),
  description: z.string().nullable().describe('Peer group description'),
  organizationId: z.string().uuid().nullable().describe('Owning organization UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type BgpPeerGroup = z.infer<typeof BgpPeerGroupSchema>;

export const CreateBgpPeerGroupRequestSchema = z.object({
  name: z.string().min(1).describe('Peer group name'),
  description: z.string().trim().optional().describe('Peer group description'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type CreateBgpPeerGroupRequest = z.infer<typeof CreateBgpPeerGroupRequestSchema>;

export const UpdateBgpPeerGroupRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Peer group name'),
  description: z.string().trim().nullable().optional().describe('Peer group description'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type UpdateBgpPeerGroupRequest = z.infer<typeof UpdateBgpPeerGroupRequestSchema>;

export const BgpPeerGroupListQuerySchema = z.object({
  organizationId: z.string().uuid().optional().describe('Filter by organization UUID'),
  search: z.string().trim().optional().describe('Search by peer group name'),
});
export type BgpPeerGroupListQuery = z.infer<typeof BgpPeerGroupListQuerySchema>;

export const PrefixListSchema = z.object({
  id: z.string().uuid().describe('Prefix list UUID'),
  name: z.string().describe('Prefix list name'),
  description: z.string().nullable().describe('Prefix list description'),
  family: z.string().nullable().describe('Address family (e.g. ipv4, ipv6)'),
  organizationId: z.string().uuid().nullable().describe('Owning organization UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type PrefixList = z.infer<typeof PrefixListSchema>;

export const CreatePrefixListRequestSchema = z.object({
  name: z.string().min(1).describe('Prefix list name'),
  description: z.string().trim().optional().describe('Prefix list description'),
  family: z.string().trim().optional().describe('Address family (e.g. ipv4, ipv6)'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type CreatePrefixListRequest = z.infer<typeof CreatePrefixListRequestSchema>;

export const UpdatePrefixListRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Prefix list name'),
  description: z.string().trim().nullable().optional().describe('Prefix list description'),
  family: z.string().trim().nullable().optional().describe('Address family (e.g. ipv4, ipv6)'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type UpdatePrefixListRequest = z.infer<typeof UpdatePrefixListRequestSchema>;

export const PrefixListListQuerySchema = z.object({
  organizationId: z.string().uuid().optional().describe('Filter by organization UUID'),
  family: z.string().trim().optional().describe('Filter by address family'),
  search: z.string().trim().optional().describe('Search by prefix list name'),
});
export type PrefixListListQuery = z.infer<typeof PrefixListListQuerySchema>;

export const PrefixListRuleSchema = z.object({
  id: z.string().uuid().describe('Prefix list rule UUID'),
  action: z.string().describe('Rule action (e.g. permit, deny)'),
  prefix: z.string().nullable().describe('IP prefix matched by this rule'),
  ge: z.number().int().nullable().describe('Minimum prefix length (greater-than-or-equal)'),
  le: z.number().int().nullable().describe('Maximum prefix length (less-than-or-equal)'),
  sequence: z.number().int().describe('Rule sequence number determining evaluation order'),
  prefixListId: z.string().uuid().describe('Parent prefix list UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type PrefixListRule = z.infer<typeof PrefixListRuleSchema>;

export const CreatePrefixListRuleRequestSchema = z.object({
  action: z.string().min(1).describe('Rule action (e.g. permit, deny)'),
  prefix: z.string().trim().optional().describe('IP prefix matched by this rule'),
  ge: z.number().int().optional().describe('Minimum prefix length (greater-than-or-equal)'),
  le: z.number().int().optional().describe('Maximum prefix length (less-than-or-equal)'),
  sequence: z.number().int().describe('Rule sequence number determining evaluation order'),
  prefixListId: z.string().uuid().describe('Parent prefix list UUID'),
});
export type CreatePrefixListRuleRequest = z.infer<typeof CreatePrefixListRuleRequestSchema>;

export const UpdatePrefixListRuleRequestSchema = z.object({
  action: z.string().min(1).optional().describe('Rule action (e.g. permit, deny)'),
  prefix: z.string().trim().nullable().optional().describe('IP prefix matched by this rule'),
  ge: z.number().int().nullable().optional().describe('Minimum prefix length (greater-than-or-equal)'),
  le: z.number().int().nullable().optional().describe('Maximum prefix length (less-than-or-equal)'),
  sequence: z.number().int().optional().describe('Rule sequence number determining evaluation order'),
});
export type UpdatePrefixListRuleRequest = z.infer<typeof UpdatePrefixListRuleRequestSchema>;

export const PrefixListRuleListQuerySchema = z.object({
  prefixListId: z.string().uuid().optional().describe('Filter by parent prefix list UUID'),
  search: z.string().trim().optional().describe('Search by prefix or action'),
});
export type PrefixListRuleListQuery = z.infer<typeof PrefixListRuleListQuerySchema>;

export const BgpSessionSchema = z.object({
  id: z.string().uuid().describe('BGP session UUID'),
  name: z.string().describe('BGP session name'),
  status: BgpSessionStatusSchema.describe('BGP session operational status'),
  description: z.string().nullable().describe('BGP session description'),
  deviceId: z.string().uuid().nullable().describe('Associated device UUID'),
  localAsnId: z.string().uuid().nullable().describe('Local ASN UUID'),
  remoteAsnId: z.string().uuid().nullable().describe('Remote ASN UUID'),
  localAddressId: z.string().uuid().nullable().describe('Local IP address UUID'),
  remoteAddressId: z.string().uuid().nullable().describe('Remote IP address UUID'),
  peerGroupId: z.string().uuid().nullable().describe('BGP peer group UUID'),
  prefixListInId: z.string().uuid().nullable().describe('Inbound prefix list UUID'),
  prefixListOutId: z.string().uuid().nullable().describe('Outbound prefix list UUID'),
  organizationId: z.string().uuid().nullable().describe('Owning organization UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type BgpSession = z.infer<typeof BgpSessionSchema>;

export const CreateBgpSessionRequestSchema = z.object({
  name: z.string().min(1).describe('BGP session name'),
  status: BgpSessionStatusSchema.optional().describe('BGP session operational status'),
  description: z.string().trim().optional().describe('BGP session description'),
  deviceId: z.string().uuid().nullable().optional().describe('Associated device UUID'),
  localAsnId: z.string().uuid().nullable().optional().describe('Local ASN UUID'),
  remoteAsnId: z.string().uuid().nullable().optional().describe('Remote ASN UUID'),
  localAddressId: z.string().uuid().nullable().optional().describe('Local IP address UUID'),
  remoteAddressId: z.string().uuid().nullable().optional().describe('Remote IP address UUID'),
  peerGroupId: z.string().uuid().nullable().optional().describe('BGP peer group UUID'),
  prefixListInId: z.string().uuid().nullable().optional().describe('Inbound prefix list UUID'),
  prefixListOutId: z.string().uuid().nullable().optional().describe('Outbound prefix list UUID'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type CreateBgpSessionRequest = z.infer<typeof CreateBgpSessionRequestSchema>;

export const UpdateBgpSessionRequestSchema = z.object({
  name: z.string().min(1).optional().describe('BGP session name'),
  status: BgpSessionStatusSchema.optional().describe('BGP session operational status'),
  description: z.string().trim().nullable().optional().describe('BGP session description'),
  deviceId: z.string().uuid().nullable().optional().describe('Associated device UUID'),
  localAsnId: z.string().uuid().nullable().optional().describe('Local ASN UUID'),
  remoteAsnId: z.string().uuid().nullable().optional().describe('Remote ASN UUID'),
  localAddressId: z.string().uuid().nullable().optional().describe('Local IP address UUID'),
  remoteAddressId: z.string().uuid().nullable().optional().describe('Remote IP address UUID'),
  peerGroupId: z.string().uuid().nullable().optional().describe('BGP peer group UUID'),
  prefixListInId: z.string().uuid().nullable().optional().describe('Inbound prefix list UUID'),
  prefixListOutId: z.string().uuid().nullable().optional().describe('Outbound prefix list UUID'),
  organizationId: z.string().uuid().nullable().optional().describe('Owning organization UUID'),
});
export type UpdateBgpSessionRequest = z.infer<typeof UpdateBgpSessionRequestSchema>;

export const BgpSessionListQuerySchema = z.object({
  organizationId: z.string().uuid().optional().describe('Filter by organization UUID'),
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  peerGroupId: z.string().uuid().optional().describe('Filter by peer group UUID'),
  status: BgpSessionStatusSchema.optional().describe('Filter by session status'),
  search: z.string().trim().optional().describe('Search by session name'),
});
export type BgpSessionListQuery = z.infer<typeof BgpSessionListQuerySchema>;
