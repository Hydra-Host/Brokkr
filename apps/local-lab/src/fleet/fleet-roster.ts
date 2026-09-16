import type { BareMetalNode, NodeKind } from '@repo/local-lab-contract';

import { bmDeviceUuid, simDeviceUuid } from '../common/hub-client';

/** One addressable machine in the active fleet, in roster order — the index callers pin tests to. */
export interface RosterNode {
  name: string;
  kind: NodeKind;
  deviceId: string;
  pxeMac: string | null;
  bmcIp: string | null;
  zone: string | null;
  systemId?: string | null;
}

export interface RosterSources {
  vmNodeNames: () => string[];
  baremetalNodes: () => BareMetalNode[];
}

const vmRoster = (sources: RosterSources): RosterNode[] =>
  sources.vmNodeNames().map((name, index) => ({
    name,
    kind: 'vm',
    deviceId: simDeviceUuid(index),
    pxeMac: null,
    bmcIp: null,
    zone: null,
    systemId: null,
  }));

const bmRoster = (sources: RosterSources): RosterNode[] =>
  sources
    .baremetalNodes()
    // a blank PXE MAC has no derivable identity — every such machine would collide on one device id.
    .filter((n) => n.pxe_mac.trim() !== '')
    .map((n) => ({
      name: n.name,
      kind: 'baremetal',
      deviceId: bmDeviceUuid(n.pxe_mac),
      pxeMac: n.pxe_mac,
      bmcIp: n.bmc_ip || null,
      zone: n.zone ?? null,
      systemId: n.system_id,
    }));

/** VM rows first, then bare-metal rows; an empty roster is a plane that is off. */
export const resolveRoster = (sources: RosterSources): RosterNode[] => [...vmRoster(sources), ...bmRoster(sources)];
