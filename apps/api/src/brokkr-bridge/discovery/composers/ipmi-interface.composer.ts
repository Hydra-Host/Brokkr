import { Injectable } from '@nestjs/common';
import { InterfaceType } from '@repo/database';
import { bmcSchema } from '../collectors/bmc/bmc.schema';
import type { CollectorContext, DeviceMutation, InterfaceUpsert } from '../collectors/collector.types';
import type { Composer } from './composer.types';

const BLANK_MAC_ADDRESSES = new Set(['00:00:00:00:00:00', '00-00-00-00-00-00', '']);
const BLANK_IPS = new Set(['0.0.0.0', '::', '']);

@Injectable()
export class IpmiInterfaceComposer implements Composer {
  readonly name = 'ipmi-interface';

  async compose(ctx: CollectorContext): Promise<DeviceMutation> {
    const parsed = bmcSchema.safeParse(ctx.rawBundle.bmc);
    if (!parsed.success) return {};

    const mac = normaliseMac(parsed.data.mac);
    if (!mac) return {};

    const ipAddresses = [parsed.data.ipv4, parsed.data.ipv6 ?? null].filter((ip): ip is string => !isBlankBmcIp(ip));

    const upsert: InterfaceUpsert = {
      name: 'IPMI',
      type: InterfaceType.IPMI_BMC,
      macAddress: mac,
      mgmtOnly: true,
      enabled: true,
      description: 'BMC management interface',
      ...(ipAddresses.length ? { ipAddresses } : {}),
    };

    return { upserts: { interfaces: [upsert] } };
  }
}

function normaliseMac(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (BLANK_MAC_ADDRESSES.has(trimmed.toUpperCase())) return null;
  return trimmed.toUpperCase();
}

export function isBlankBmcIp(ip: string | null): boolean {
  if (!ip) return true;
  const base = ip.split('/')[0] ?? '';
  return BLANK_IPS.has(base) || ['::/64', '::/48', '0.0.0.0/0'].includes(ip);
}
