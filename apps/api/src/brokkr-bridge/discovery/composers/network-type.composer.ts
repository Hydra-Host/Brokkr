import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { CollectorContext, DeviceMutation } from '../collectors/collector.types';
import { ipASchema, ipInterfaceSchema } from '../collectors/ip_a/ip_a.schema';
import { publicIpSchema } from '../collectors/public_ip/public_ip.schema';
import type { Composer } from './composer.types';

type IpIface = z.infer<typeof ipInterfaceSchema>;

@Injectable()
export class NetworkTypeComposer implements Composer {
  readonly name = 'network-type';

  async compose(ctx: CollectorContext): Promise<DeviceMutation> {
    const publicIp = publicIpSchema.safeParse(ctx.rawBundle.public_ip);
    const ipA = ipASchema.safeParse(ctx.rawBundle.ip_a);
    if (!publicIp.success || !ipA.success || !publicIp.data.ipv4) return {};

    const localIps = collectLocalIps(ipA.data);
    const isDirect = localIps.has(publicIp.data.ipv4);
    return { deviceUpdate: { networkType: isDirect ? 'Public' : 'NAT' } };
  }
}

function collectLocalIps(rawInterfaces: unknown[]): Set<string> {
  const ips = new Set<string>();
  for (const raw of rawInterfaces) {
    const parsed = ipInterfaceSchema.safeParse(raw);
    if (!parsed.success) continue;
    const iface: IpIface = parsed.data;
    if (iface.ifname === 'lo' || iface.link_type === 'loopback') continue;
    for (const addr of iface.addr_info) {
      if (addr.family === 'inet' && addr.scope === 'global' && addr.local) ips.add(addr.local);
    }
  }
  return ips;
}
