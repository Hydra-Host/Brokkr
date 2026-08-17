import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, InterfaceUpsert } from '../collector.types';
import { type IpAInput, ipASchema, ipInterfaceSchema } from './ip_a.schema';

@Injectable()
export class IpAHandler implements CollectorHandler<IpAInput> {
  readonly name = 'ip_a' as const;
  readonly schema = ipASchema;

  async handle(input: IpAInput): Promise<DeviceMutation> {
    const warnings: string[] = [];

    const parsed = input.flatMap((raw, idx) => {
      const result = ipInterfaceSchema.safeParse(raw);
      if (result.success) return [result.data];
      warnings.push(`ip_a[${idx}] malformed`);
      return [];
    });

    // a bond names itself nowhere — only its members point at it
    const masters = new Set(parsed.map((i) => i.master).filter((m): m is string => m != null));

    const interfaces: InterfaceUpsert[] = [];
    const skipped: string[] = [];

    for (const ifc of parsed) {
      if (ifc.ifname === 'lo' || ifc.link_type === 'loopback') continue;
      if (/^enx[0-9a-f]{12}$/i.test(ifc.ifname)) continue;
      // a VLAN carries `link` (its parent device); a bond is named by `master`
      if (ifc.link || masters.has(ifc.ifname)) {
        skipped.push(ifc.ifname);
        continue;
      }

      const operstate = ifc.operstate ?? null;
      const hasNoCarrier = ifc.flags.includes('NO-CARRIER');
      interfaces.push({
        name: ifc.ifname,
        operstate,
        linkOperUp: operstate === 'UP',
        linkPhysicalUp: !hasNoCarrier,
      });
    }

    if (skipped.length) warnings.push(`ip_a: skipped bond/vlan device(s): ${skipped.join(', ')}`);

    return {
      upserts: interfaces.length ? { interfaces } : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}
