import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';
import type { CollectorHandler, DeviceMutation, InterfaceUpsert } from '../collector.types';
import { type LldpInput, lldpSchema } from './lldp.schema';

interface ParsedNeighbor {
  interfaceName: string;
  chassisName: string | null;
  descr: string | null;
  mgmtIp: string | null;
  portId: string | null;
  portDescr: string | null;
}

@Injectable()
export class LldpHandler implements CollectorHandler<LldpInput> {
  readonly name = 'lldp' as const;
  readonly schema = lldpSchema;

  async handle(input: LldpInput): Promise<DeviceMutation> {
    const raw = input.lldp.interface;
    if (raw == null) return {};

    const neighbors = extractNeighbors(raw);
    const interfaces: InterfaceUpsert[] = neighbors.map((n) => ({
      name: n.interfaceName,
      lldpNeighborName: n.chassisName,
      lldpNeighborDescr: n.descr,
      lldpNeighborMgmtIp: n.mgmtIp,
      lldpNeighborPort: n.portId ?? n.portDescr,
    }));

    return { upserts: interfaces.length ? { interfaces } : undefined };
  }
}

function extractNeighbors(raw: unknown): ParsedNeighbor[] {
  const entries = Array.isArray(raw) ? raw : [raw];
  const result: ParsedNeighbor[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    for (const [ifaceName, ifaceData] of Object.entries(entry)) {
      if (!isRecord(ifaceData)) continue;
      result.push(parseInterfaceEntry(ifaceName, ifaceData));
    }
  }
  return result;
}

function parseInterfaceEntry(ifaceName: string, data: Record<string, unknown>): ParsedNeighbor {
  const chassis = isRecord(data.chassis) ? data.chassis : null;
  let chassisName: string | null = null;
  let descr: string | null = null;
  let mgmtIp: string | null = null;

  if (chassis) {
    const chassisEntries = Object.entries(chassis);
    if (chassisEntries.length > 0) {
      const [name, info] = chassisEntries[0];
      chassisName = name;
      if (isRecord(info)) {
        descr = typeof info.descr === 'string' ? info.descr : null;
        const mgmt = info['mgmt-ip'];
        if (Array.isArray(mgmt) && mgmt.length > 0 && typeof mgmt[0] === 'string') {
          mgmtIp = mgmt[0];
        } else if (typeof mgmt === 'string') {
          mgmtIp = mgmt;
        }
      }
    }
  }

  const port = isRecord(data.port) ? data.port : null;
  let portId: string | null = null;
  let portDescr: string | null = null;
  if (port) {
    if (isRecord(port.id) && typeof port.id.value === 'string') portId = port.id.value;
    if (typeof port.descr === 'string') portDescr = port.descr;
  }

  return { interfaceName: ifaceName, chassisName, descr, mgmtIp, portId, portDescr };
}
