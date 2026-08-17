import { z } from 'zod';

export const BridgePresenceInterfaceSchema = z.object({
  iface: z.string(),
  mac: z.string(),
  subnet: z.string(),
  ip: z.string(),
  gateway: z.string().optional(),
  routed: z.boolean().optional(),
});

export const BridgePresencePluginSchema = z.object({
  id: z.string(),
  version: z.string(),
});

export const BridgePresenceHashSchema = z.object({
  instance_id: z.string().min(1),
  is_leader: z.string().optional(),
  brokkr_worker_version: z.string().optional(),
  brokkr_live_version: z.string().optional(),
  registered_at: z.string().optional(),
  interfaces_json: z.string().optional(),
  active_plugins_json: z.string().optional(),
});

export type BridgePresenceHash = z.infer<typeof BridgePresenceHashSchema>;
