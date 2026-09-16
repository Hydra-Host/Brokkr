import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  CollectorContext,
  DeviceMutation,
  InterfaceUpsert,
  NatMappingUpsert,
} from '../collectors/collector.types';
import { isUsbIpmiNicName, osInterfaceName } from '../collectors/interface-name';
import { ipASchema, ipInterfaceSchema } from '../collectors/ip_a/ip_a.schema';
import { publicIpSchema } from '../collectors/public_ip/public_ip.schema';
import { routeSchema } from '../collectors/route/route.schema';
import type { Composer } from './composer.types';

type IpIface = z.infer<typeof ipInterfaceSchema>;

@Injectable()
export class NetworkIpComposer implements Composer {
  readonly name = 'network-ip';

  async compose(ctx: CollectorContext): Promise<DeviceMutation> {
    const ipA = ipASchema.safeParse(ctx.rawBundle.ip_a);
    if (!ipA.success) return {};
    const route = routeSchema.safeParse(ctx.rawBundle.route);
    const publicIp = publicIpSchema.safeParse(ctx.rawBundle.public_ip);

    const interfaces = ipA.data
      .map((raw) => {
        const parsed = ipInterfaceSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      })
      .filter((i): i is IpIface => i !== null && !isExcluded(i));

    const defaultIface4 = route.success
      ? route.data.find((r) => r.destination === '0.0.0.0' && r.flags.includes('G'))?.iface
      : undefined;

    const interfaceUpserts: InterfaceUpsert[] = [];
    for (const iface of interfaces) {
      const ipAddresses = globalCidrs(iface);
      const name = osInterfaceName(iface.ifname, iface.altnames);
      if (ipAddresses.length) interfaceUpserts.push({ name, ipAddresses });
    }

    const natMappings = this.deriveNatMappings(interfaces, defaultIface4, publicIp);

    const upserts: DeviceMutation['upserts'] = {};
    if (interfaceUpserts.length) upserts.interfaces = interfaceUpserts;
    if (natMappings.length) upserts.natMappings = natMappings;
    return Object.keys(upserts).length ? { upserts } : {};
  }

  private deriveNatMappings(
    interfaces: IpIface[],
    defaultIface4: string | undefined,
    publicIp: ReturnType<typeof publicIpSchema.safeParse>,
  ): NatMappingUpsert[] {
    if (!publicIp.success) return [];
    const mappings: NatMappingUpsert[] = [];

    const localV4 = localGlobalSet(interfaces, 'inet');
    const insideV4 = pickGlobalAddress(interfaces, 'inet', defaultIface4);
    if (publicIp.data.ipv4 && insideV4 && !localV4.has(publicIp.data.ipv4)) {
      mappings.push({ outsideAddress: publicIp.data.ipv4, insideAddress: insideV4 });
    }

    const localV6 = localGlobalSet(interfaces, 'inet6');
    const insideV6 = pickGlobalAddress(interfaces, 'inet6', undefined);
    if (publicIp.data.ipv6 && insideV6 && !localV6.has(publicIp.data.ipv6)) {
      mappings.push({ outsideAddress: publicIp.data.ipv6, insideAddress: insideV6 });
    }

    return mappings;
  }
}

function isExcluded(iface: IpIface): boolean {
  return iface.ifname === 'lo' || iface.link_type === 'loopback' || isUsbIpmiNicName(iface.ifname);
}

function globalCidrs(iface: IpIface): string[] {
  const out: string[] = [];
  for (const a of iface.addr_info) {
    if (!a.local || a.scope !== 'global') continue;
    if (a.family !== 'inet' && a.family !== 'inet6') continue;
    out.push(a.prefixlen !== undefined ? `${a.local}/${a.prefixlen}` : a.local);
  }
  return out;
}

function localGlobalSet(interfaces: IpIface[], family: 'inet' | 'inet6'): Set<string> {
  const ips = new Set<string>();
  for (const iface of interfaces) {
    for (const a of iface.addr_info) {
      if (a.family === family && a.scope === 'global' && a.local) ips.add(a.local);
    }
  }
  return ips;
}

function pickGlobalAddress(
  interfaces: IpIface[],
  family: 'inet' | 'inet6',
  preferredIface: string | undefined,
): string | null {
  const findAddr = (iface: IpIface) =>
    iface.addr_info.find((a) => a.family === family && a.scope === 'global' && a.local)?.local ?? null;

  if (preferredIface) {
    const pref = interfaces.find((i) => i.ifname === preferredIface);
    const addr = pref ? findAddr(pref) : null;
    if (addr) return addr;
  }
  for (const iface of interfaces) {
    const addr = findAddr(iface);
    if (addr) return addr;
  }
  return null;
}
