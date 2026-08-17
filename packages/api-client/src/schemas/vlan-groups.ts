import { z } from 'zod';
import { VLAN_VID_MAX, VLAN_VID_MIN } from './ipam';

export const VlanGroupSchema = z.object({
  id: z.string().uuid().describe('VLAN group UUID'),
  name: z.string().describe('VLAN group name'),
  description: z.string().nullable().describe('VLAN group description'),
  minVid: z.number().int().describe('Minimum VLAN ID in this group'),
  maxVid: z.number().int().describe('Maximum VLAN ID in this group'),
  zoneId: z.string().uuid().nullable().describe('Associated zone UUID'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type VlanGroup = z.infer<typeof VlanGroupSchema>;

export const CreateVlanGroupRequestSchema = z.object({
  name: z.string().min(1).describe('VLAN group name'),
  description: z.string().trim().nullable().optional().describe('VLAN group description'),
  minVid: z.number().int().min(VLAN_VID_MIN).max(VLAN_VID_MAX).optional().describe('Minimum VLAN ID in this group'),
  maxVid: z.number().int().min(VLAN_VID_MIN).max(VLAN_VID_MAX).optional().describe('Maximum VLAN ID in this group'),
  zoneId: z.string().uuid().nullable().optional().describe('Associated zone UUID'),
});
export type CreateVlanGroupRequest = z.infer<typeof CreateVlanGroupRequestSchema>;

export const UpdateVlanGroupRequestSchema = z.object({
  name: z.string().min(1).optional().describe('VLAN group name'),
  description: z.string().trim().nullable().optional().describe('VLAN group description'),
  minVid: z.number().int().min(VLAN_VID_MIN).max(VLAN_VID_MAX).optional().describe('Minimum VLAN ID in this group'),
  maxVid: z.number().int().min(VLAN_VID_MIN).max(VLAN_VID_MAX).optional().describe('Maximum VLAN ID in this group'),
});
export type UpdateVlanGroupRequest = z.infer<typeof UpdateVlanGroupRequestSchema>;

export const VlanGroupListQuerySchema = z.object({
  zoneId: z.string().uuid().optional().describe('Filter by zone UUID'),
});
export type VlanGroupListQuery = z.infer<typeof VlanGroupListQuerySchema>;
