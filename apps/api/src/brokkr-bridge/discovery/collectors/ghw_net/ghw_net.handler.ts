import { Injectable } from '@nestjs/common';
import type { CollectorContext, CollectorHandler, DeviceMutation, InterfaceUpsert } from '../collector.types';
import { isUsbIpmiNicName, osInterfaceName } from '../interface-name';
import { ipASchema, ipInterfaceSchema } from '../ip_a/ip_a.schema';
import { type GhwNetInput, ghwNetNicSchema, ghwNetSchema } from './ghw_net.schema';

const PSEUDO_NAMES = new Set(['bonding_masters']);

@Injectable()
export class GhwNetHandler implements CollectorHandler<GhwNetInput> {
  readonly name = 'ghw_net' as const;
  readonly schema = ghwNetSchema;

  async handle(input: GhwNetInput, ctx?: CollectorContext): Promise<DeviceMutation> {
    const { macs: permanentMacs, osNames } = indexIpA(ctx?.rawBundle.ip_a);
    const interfaces: InterfaceUpsert[] = [];
    const warnings: string[] = [];

    input.network.nics.forEach((raw, idx) => {
      const parsed = ghwNetNicSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`ghw_net.nics[${idx}] malformed`);
        return;
      }
      const nic = parsed.data;
      if (PSEUDO_NAMES.has(nic.name) || nic.is_virtual || isUsbIpmiNicName(nic.name)) return;

      const speedMbps = parseSpeedToMbps(nic.speed);
      const mac = permanentMacs.get(nic.name) ?? nic.mac_address.trim().toLowerCase();
      interfaces.push({
        // `ip_a` resolved the udev name already; agreeing with it keeps one NIC on one row
        name: osNames.get(nic.name) ?? nic.name,
        // omitted rather than null: an unreadable MAC must not erase a known one
        ...(mac ? { macAddress: mac } : {}),
        speed: speedMbps,
        type: speedToInterfaceType(speedMbps),
      });
    });

    return {
      upserts: interfaces.length ? { interfaces } : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}

// kernel NIC name -> hardware MAC, name -> udev name
function indexIpA(raw: unknown): { macs: Map<string, string>; osNames: Map<string, string> } {
  const macs = new Map<string, string>();
  const osNames = new Map<string, string>();
  const ipA = ipASchema.safeParse(raw);
  if (!ipA.success) return { macs, osNames };
  for (const entry of ipA.data) {
    const parsed = ipInterfaceSchema.safeParse(entry);
    if (!parsed.success) continue;
    const permaddr = parsed.data.permaddr?.trim().toLowerCase();
    if (permaddr) macs.set(parsed.data.ifname, permaddr);
    osNames.set(parsed.data.ifname, osInterfaceName(parsed.data.ifname, parsed.data.altnames));
  }
  return { macs, osNames };
}

function parseSpeedToMbps(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([\d.]+)\s*(G|Gbps|M|Mbps)?\b/i);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (Number.isNaN(n)) return null;
  const unit = (match[2] ?? '').toLowerCase();
  if (!unit || unit.startsWith('m')) return Math.round(n);
  return Math.round(n * 1000);
}

function speedToInterfaceType(mbps: number | null): InterfaceUpsert['type'] {
  if (mbps == null) return null;
  if (mbps >= 800_000) return 'ETHERNET_800G';
  if (mbps >= 400_000) return 'ETHERNET_400G';
  if (mbps >= 200_000) return 'ETHERNET_200G';
  if (mbps >= 100_000) return 'ETHERNET_100G';
  if (mbps >= 50_000) return 'ETHERNET_50G';
  if (mbps >= 40_000) return 'ETHERNET_40G';
  if (mbps >= 25_000) return 'ETHERNET_25G';
  if (mbps >= 10_000) return 'ETHERNET_10G';
  if (mbps >= 1_000) return 'ETHERNET_1G';
  return null;
}
