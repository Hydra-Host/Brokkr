import type Redis from 'ioredis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { z } from 'zod';
import { BridgePresenceInterfaceSchema, BridgePresencePluginSchema } from './bridge-presence.schema';

const PRESENCE_FRESH_SECONDS = 25;

const PresenceInterfacesSchema = z.array(BridgePresenceInterfaceSchema);
const PresencePluginsSchema = z.array(BridgePresencePluginSchema);

export interface PresenceInterface {
  name: string;
  macAddress: string;
  address: string;
}

export interface PresencePlugin {
  id: string;
  version: string;
}

export interface BridgePresence {
  online: boolean;
  isLeader: boolean;
  interfaces: PresenceInterface[];
  activePlugins: PresencePlugin[];
}

export const OFFLINE_PRESENCE: BridgePresence = {
  online: false,
  isLeader: false,
  interfaces: [],
  activePlugins: [],
};

function parseInterfaces(raw: string | undefined): PresenceInterface[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = PresenceInterfacesSchema.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.map((entry) => {
    const prefix = entry.subnet.includes('/') ? entry.subnet.split('/')[1] : '';
    return { name: entry.iface, macAddress: entry.mac, address: prefix ? `${entry.ip}/${prefix}` : entry.ip };
  });
}

function parseActivePlugins(raw: string | undefined): PresencePlugin[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = PresencePluginsSchema.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.map((entry) => ({ id: entry.id, version: entry.version }));
}

export function toPresence(hash: Record<string, string>): BridgePresence {
  const registeredAt = hash.registered_at ? Number.parseFloat(hash.registered_at) : Number.NaN;
  const online = Number.isFinite(registeredAt) && Date.now() / 1000 - registeredAt < PRESENCE_FRESH_SECONDS;
  return {
    online,
    isLeader: online && hash.is_leader === 'True',
    interfaces: online ? parseInterfaces(hash.interfaces_json) : [],
    activePlugins: online ? parseActivePlugins(hash.active_plugins_json) : [],
  };
}

export async function lookupBridgePresence(
  redis: Redis,
  devices: Array<{ id: string; zoneId: string | null; name: string }>,
): Promise<Map<string, BridgePresence>> {
  const entries = await Promise.all(
    devices.map(async (device): Promise<[string, BridgePresence]> => {
      if (!device.zoneId) return [device.id, OFFLINE_PRESENCE];
      const hash = await redis.hgetall(REDIS_KEYS.bridgeInstance(device.zoneId, device.name));
      return [device.id, toPresence(hash)];
    }),
  );
  return new Map(entries);
}
