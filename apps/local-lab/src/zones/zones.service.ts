import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import {
  RESERVED_ZONE_NAME,
  ZONE_INDEX_MAX,
  ZONE_INDEX_MIN,
  type Zone,
  type ZoneApplyPlan,
  type ZonesConfig,
  type ZoneWrite,
} from '@repo/local-lab-contract';
import { ZoneRegistryService } from '../datastore/zone-registry.service';
import { OverlayStoreService } from '../services/overlay-store';
import { zoneRefusal } from './zone-rules';

const OVERLAY_FILE = 'stack.local.nix';

/** Byte-identical to zones.nix zoneUuid and local/zones.py zone_uuid, which the SQL seed writes the
 *  hub Zone row from; 11 + index must stay two digits to fill the group, which is what bounds it. */
const ZONE_UUID_PREFIX = '00000000-0000-0000-0000-1111111111';
export const zoneUuid = (index: number): string => {
  if (!Number.isInteger(index) || index < ZONE_INDEX_MIN || index > ZONE_INDEX_MAX) {
    throw new RangeError(`zone index ${index} out of range ${ZONE_INDEX_MIN}..${ZONE_INDEX_MAX}`);
  }
  return `${ZONE_UUID_PREFIX}${String(11 + index).padStart(2, '0')}`;
};

/** The ACL username is keyed to the unchanged zone uuid while the password derives from the name, so
 *  a redeploy before the seed crash-loops the bridge on WRONGPASS. */
const RENAME_STEPS: ZoneApplyPlan['steps'] = [
  { id: 'sim:seed', label: 'Re-seed the hub', why: 'the Zone row upserts by id, so this is what changes its name' },
  {
    id: 'redis-acl:seed',
    label: 'Re-provision the Redis ACL',
    why: 'the password derives from the zone name and the seeder finds the zone by it, so it needs the new name to exist first',
  },
  {
    id: 'zone-crypto:mint-tokens',
    label: 'Re-mint the zone token',
    why: 'the registration token is stored under the zone name',
  },
  {
    id: 'restart the bridges',
    label: 'Restart the bridges',
    why: 'running this before the seed leaves the bridge dialling with the old password and crash-looping on WRONGPASS',
  },
];

/** A new or moved index means a new zone uuid that nothing downstream has been told about: the hub
 *  has no Zone row for it, redis no brokkr-spoke-<uuid> user, and the mint no token. */
const PROVISION_STEPS: ZoneApplyPlan['steps'] = [
  {
    id: 'sim:seed',
    label: 'Seed the hub zone',
    why: 'the uuid derives from the index, so a new or moved index has no Zone row yet, and a moved one leaves the row at its old uuid behind',
  },
  {
    id: 'redis-acl:seed',
    label: 'Provision the Redis ACL',
    why: 'the acl user is brokkr-spoke-<uuid>, so a new uuid has no user for the bridge to authenticate as',
  },
  {
    id: 'zone-crypto:mint-tokens',
    label: 'Mint the zone token',
    why: 'the bridge needs a registration token issued for this zone before it can enroll',
  },
  {
    id: 'restart the bridges',
    label: 'Restart the bridges',
    why: 'running this before the three above leaves the bridge dialling an acl user that does not exist yet',
  },
];

const ROSTER_STEP: ZoneApplyPlan['steps'] = [
  {
    id: 'restart the bridges',
    label: 'Regenerate the process roster and restart the bridges',
    why: 'a bridge count change adds or removes spoke processes, which only a roster update creates',
  },
];

@Injectable()
export class ZonesService {
  private readonly log = new Logger(ZonesService.name);

  constructor(
    private readonly overlay: OverlayStoreService,
    private readonly zoneRegistry: ZoneRegistryService,
  ) {}

  async getConfig(): Promise<ZonesConfig> {
    const declared = this.overlay.zonesMeta();
    const bridges = this.overlay.labBridges();
    const nodesByZone = this.overlay.fleetNodesByZone();
    const bmByZone = this.overlay.baremetalNodesByZone();
    const zoneFiles = this.overlay.zoneFiles();
    const { zones: hubZones, readError } = await this.zoneRegistry.readZones();
    const live = hubZones.filter((row) => !row.deletedAt);

    const zones: Zone[] = [...declared]
      .sort((a, b) => a.index - b.index)
      .map((zone) => {
        const own = bridges.filter((bridge) => bridge.zone === zone.name);
        const declaredElsewhere = (zoneFiles[zone.name] ?? []).filter((file) => file !== OVERLAY_FILE);
        return {
          name: zone.name,
          index: zone.index,
          bridges: zone.bridges,
          baseDeclared: zoneFiles[zone.name] === undefined || declaredElsewhere.length > 0,
          derived: {
            uuid: zoneUuid(zone.index),
            ordinals: own.map((bridge) => bridge.replica),
            bridges: own.map((bridge) => ({ proc: bridge.proc, port: bridge.port, grpc: bridge.grpc })),
            nodeCount: (nodesByZone[zone.name] ?? []).length + (bmByZone[zone.name] ?? []).length,
          },
        };
      });

    const declaredNames = new Set(zones.map((zone) => zone.name));
    const liveNames = new Set(live.map((row) => row.name));
    const reconcile: ZonesConfig['reconcile'] = [
      ...live
        .filter((row) => row.name === null || !declaredNames.has(row.name))
        .map((row) => ({
          name: row.name,
          zoneId: row.id,
          side: 'hub-only' as const,
          fixture: row.name === RESERVED_ZONE_NAME,
        })),
      ...zones
        .filter((zone) => !liveNames.has(zone.name))
        .map((zone) => ({ name: zone.name, zoneId: null, side: 'fleet-only' as const, fixture: false })),
    ];

    return {
      seeded: this.overlay.isSeeded(),
      zones,
      capacity: { used: zones.reduce((n, zone) => n + zone.bridges, 0), total: this.overlay.zoneCapacity() },
      reservedNames: [RESERVED_ZONE_NAME],
      reconcile,
      hubReadError: readError,
    };
  }

  async putConfig(input: {
    zones: ZoneWrite[];
    rename?: { from: string; to: string };
    nodeZones?: Record<string, string>;
  }): Promise<{ ok: boolean; plan: ZoneApplyPlan }> {
    const declared = this.overlay.zonesMeta();
    const nodesByZone = this.overlay.fleetNodesByZone();
    const bmByZone = this.overlay.baremetalNodesByZone();
    const { zones: hubZones, readError } = await this.zoneRegistry.readZones();
    // an unreadable hub yields an empty name list, which would pass the rename clash check
    // vacuously — the one thing that check exists to catch
    if (readError !== null && input.rename) {
      throw new BadRequestException(
        `the hub Zone rows could not be read (${readError}), so a rename cannot be checked for a name clash; Zone.name has no unique index, so the acl seeder would provision onto an arbitrary row`,
      );
    }
    // a rename moves its nodes with it: reporting them under the old name would refuse the save for
    // naming a zone that is no longer declared
    const nodeZones = renamed(input.nodeZones ?? currentNodeZones(nodesByZone), input.rename);

    const refusal = zoneRefusal({
      desired: input.zones,
      declared,
      nodeZones,
      nodesByZone,
      occupancyByZone: occupancy(nodesByZone, bmByZone),
      rename: input.rename,
      capacity: this.overlay.zoneCapacity(),
      hubZoneNames: hubZones.filter((row) => !row.deletedAt && row.name !== null).map((row) => row.name as string),
    });
    if (refusal) throw new BadRequestException(refusal);

    // a pure rename moves no node: the zone keeps its index, so its uuid and every derived node
    // identity stay put. Compare against the pre-rename names to avoid calling that a rebuild.
    const wasZoneOf = (node: string): string | undefined =>
      Object.entries(nodesByZone).find(([, nodes]) => nodes.includes(node))?.[0];
    const canonical = (zone: string): string => (input.rename && zone === input.rename.to ? input.rename.from : zone);
    const movedNode = Object.entries(nodeZones).some(([node, zone]) => {
      const was = wasZoneOf(node);
      return was !== undefined && was !== canonical(zone);
    });
    const steps = input.rename
      ? RENAME_STEPS
      : mintsZoneIdentity(input.zones, declared, input.rename)
        ? PROVISION_STEPS
        : ROSTER_STEP;
    this.overlay.setZonesConfig({ zones: input.zones, nodeZones, steps });
    this.log.log(
      `saved ${input.zones.length} zone(s) to the stack overlay${input.rename ? ` (renamed ${input.rename.from} → ${input.rename.to})` : ''}`,
    );
    return { ok: true, plan: { steps, fullRebuild: movedNode } };
  }
}

/** True when the save creates or moves a zone uuid: a zone the overlay does not declare, or a
 *  declared one whose index changed. A rename keeps its index, so its target is not an addition. */
const mintsZoneIdentity = (
  desired: ZoneWrite[],
  declared: { name: string; index: number }[],
  rename?: { from: string; to: string },
): boolean => {
  const indexByName = new Map(declared.map((z) => [z.name, z.index]));
  return desired.some((z) => {
    const was = indexByName.get(z.name);
    return was === undefined ? z.name !== rename?.to : was !== z.index;
  });
};

// removal refuses on every occupant, vm node or bare-metal machine; nodeZones stays vm-only because
// it is the write path and a machine's zone lives in its own row
const occupancy = (vm: Record<string, string[]>, bm: Record<string, string[]>): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [zone, names] of [...Object.entries(vm), ...Object.entries(bm)])
    out[zone] = [...(out[zone] ?? []), ...names];
  return out;
};

const renamed = (
  nodeZones: Record<string, string>,
  rename: { from: string; to: string } | undefined,
): Record<string, string> =>
  rename === undefined
    ? nodeZones
    : Object.fromEntries(
        Object.entries(nodeZones).map(([node, zone]) => [node, zone === rename.from ? rename.to : zone]),
      );

/** What the overlay already says, so a write that omits nodeZones does not read as "every node lost
 *  its zone" and trip the multi-zone rule. */
function currentNodeZones(nodesByZone: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [zone, nodes] of Object.entries(nodesByZone)) for (const node of nodes) out[node] = zone;
  return out;
}
