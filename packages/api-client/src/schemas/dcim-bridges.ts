import { z } from 'zod';

import { InterfaceSchema } from './interface';

export const BridgeTypeEnum = z.enum(['managed', 'self-hosted']).describe('Deployment model of the bridge');
export type BridgeType = z.infer<typeof BridgeTypeEnum>;

export const BridgeResponseSchema = z.object({
  id: z.string().describe('Brokkr Device UUID of the bridge'),
  name: z.string().describe('Display name of the bridge'),
  status: z.string().describe('Current operational status of the bridge'),
  type: BridgeTypeEnum.describe('Deployment model of the bridge'),
  datacenter: z
    .object({
      id: z.string().describe('Brokkr Zone UUID of the datacenter'),
      name: z.string().describe('Name of the datacenter'),
    })
    .describe('Datacenter the bridge is located in'),
  zone: z
    .object({
      id: z.string().describe('Brokkr Zone UUID'),
      name: z.string().describe('Name of the zone'),
    })
    .describe('Zone the bridge is assigned to'),
  interfaces: z.array(InterfaceSchema).describe('Network interfaces attached to the bridge'),
  online: z
    .boolean()
    .describe('Whether the bridge is reporting live right now (recent Redis heartbeat); derived at read time'),
  is_leader: z.boolean().describe('Whether this bridge currently holds zone leadership'),
  active_plugins: z
    .array(
      z.object({
        id: z.string().describe('Stable plugin identifier from the plugin manifest'),
        version: z.string().describe('Version of the plugin active on the bridge'),
      }),
    )
    .describe(
      'Bridge plugins active on this instance, self-reported via the live presence heartbeat; empty when offline',
    ),
});

export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;
