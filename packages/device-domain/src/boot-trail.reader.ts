import {
  type BootExpected,
  type BootTrail,
  ChainHitValueSchema,
  type DeviceBootTrail,
  PxeDecisionHashSchema,
} from '@repo/api-client';
import { JobType, type LifecycleJobPhase, ServerLifecycleStatus } from '@repo/database';
import { TERMINAL_PHASES } from '@repo/lifecycle';
import { canonicalMac, type DataMacTier, getErrorMessage, pickDataInterface } from '@repo/utils';
import { deviceRedisKeys } from './redis-keys';

const NETWORK_BOOT_JOB_TYPES = [JobType.Provision, JobType.Reprovision, JobType.Deprovision];

export const UNREADABLE = (readError: string): BootTrail => ({
  pxe: null,
  chainReached: null,
  chainAtMs: null,
  chainDeviceMismatch: false,
  readError,
});

// Pick<Redis, 'pipeline'> still demands the full ChainableCommander; this names only the three commands the reader issues
export interface MarkerPipeline {
  hgetall(key: string): MarkerPipeline;
  get(key: string): MarkerPipeline;
  exists(key: string): MarkerPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface MarkerRedis {
  pipeline(): MarkerPipeline;
}

export interface BootTrailInterfaceRow {
  name: string;
  macAddress: string | null;
  mgmtOnly: boolean;
  ipAddresses: Array<{ address: string }>;
}

// the two reads the trail needs, named so a spec fake stays cast-free; PrismaClient satisfies both
export interface BootTrailPrisma {
  interface: {
    findMany(args: {
      where: { deviceId: string; deletedAt: null };
      orderBy: { name: 'asc' };
      select: {
        name: true;
        macAddress: true;
        mgmtOnly: true;
        ipAddresses: { where: { deletedAt: null }; select: { address: true } };
      };
    }): Promise<BootTrailInterfaceRow[]>;
  };
  lifecycleJob: {
    findFirst(args: {
      where: { deviceId: string; jobType: { in: JobType[] }; phase: { notIn: LifecycleJobPhase[] } };
      orderBy: { createdAt: 'desc' };
      select: { createdAt: true };
    }): Promise<{ createdAt: Date } | null>;
  };
}

export interface BootTrailInput {
  deviceId: string;
  zoneId: string | null;
  lifecycleStatus: ServerLifecycleStatus | null;
  statusChangedAt: Date | null;
}

// a chain value that does not parse still proves the hit; only its time and device are unknown
export function parseChainHit(raw: string): { atMs: number; deviceId: string | null } | null {
  try {
    const parsed = ChainHitValueSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function bootExpected(
  prisma: Pick<BootTrailPrisma, 'lifecycleJob'>,
  { deviceId, lifecycleStatus, statusChangedAt }: Omit<BootTrailInput, 'zoneId'>,
): Promise<BootExpected> {
  // raw read on purpose: the caller's device pin scoped the device, and the job row's organizationId is the requester, not the supplier
  const job = await prisma.lifecycleJob.findFirst({
    where: { deviceId, jobType: { in: NETWORK_BOOT_JOB_TYPES }, phase: { notIn: [...TERMINAL_PHASES] } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (job) return { expected: true, since: job.createdAt.toISOString(), reason: 'active-job' };
  if (lifecycleStatus === ServerLifecycleStatus.PROVISIONING && statusChangedAt !== null) {
    return { expected: true, since: statusChangedAt.toISOString(), reason: 'provisioning-status' };
  }
  return { expected: false, since: null, reason: 'none' };
}

interface Candidate {
  name: string;
  mac: string;
  tier: DataMacTier;
}

type PxeMacSource = NonNullable<DeviceBootTrail['pxeMacSource']>;

// the addressed interface leads, then the rest in name order, so the tier of the head is the tier of the choice
function orderCandidates(rows: BootTrailInterfaceRow[]): Candidate[] {
  const withMac = rows.flatMap((row) => {
    const mac = row.macAddress === null ? null : canonicalMac(row.macAddress);
    return mac === null || row.mgmtOnly ? [] : [{ row, mac }];
  });
  const head = pickDataInterface(withMac.map((c) => c.row));
  if (head === undefined) return [];
  const ordered = [...withMac.filter((c) => c.row === head.iface), ...withMac.filter((c) => c.row !== head.iface)];
  return ordered.map((c, i) => ({ name: c.row.name, mac: c.mac, tier: i === 0 ? head.tier : 'name-order' }));
}

function chosen(pick: Candidate, candidates: Candidate[], source: PxeMacSource = pick.tier) {
  return {
    pxeMac: pick.mac,
    pxeInterface: pick.name,
    pxeMacSource: source,
    candidateMacs: candidates.filter((c) => c !== pick).map((c) => c.mac),
  };
}

export class BootTrailReader {
  constructor(
    private readonly redis: MarkerRedis,
    private readonly prisma: BootTrailPrisma,
  ) {}

  async read(input: BootTrailInput): Promise<DeviceBootTrail> {
    const { deviceId, zoneId } = input;
    const readAt = new Date().toISOString();
    const rows = await this.prisma.interface.findMany({
      where: { deviceId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: {
        name: true,
        macAddress: true,
        mgmtOnly: true,
        ipAddresses: { where: { deletedAt: null }, select: { address: true } },
      },
    });
    const candidates = orderCandidates(rows);
    const expected = await bootExpected(this.prisma, input);
    const first = candidates[0];

    if (first === undefined) {
      return {
        deviceId,
        pxeMac: null,
        pxeInterface: null,
        pxeMacSource: null,
        candidateMacs: [],
        zoneId: null,
        trail: UNREADABLE('no data interface with a MAC'),
        bootExpected: expected,
        readAt,
      };
    }

    if (zoneId === null) {
      return {
        deviceId,
        ...chosen(first, candidates),
        zoneId,
        trail: UNREADABLE('device is not assigned to a zone'),
        bootExpected: expected,
        readAt,
      };
    }

    const marked = await this.firstWithMarker(zoneId, candidates);
    const pick = marked === null ? chosen(first, candidates) : chosen(marked, candidates, 'marker');
    const trail = await this.readMarkers(zoneId, pick.pxeMac, deviceId);
    return { deviceId, ...pick, zoneId, trail, bootExpected: expected, readAt };
  }

  // one round trip for every candidate; a recorded boot outranks an address, which outranks name order
  private async firstWithMarker(zoneId: string, candidates: Candidate[]): Promise<Candidate | null> {
    try {
      const pipeline = this.redis.pipeline();
      for (const c of candidates) {
        pipeline
          .exists(deviceRedisKeys.dhcpPxeDecision(zoneId, c.mac))
          .exists(deviceRedisKeys.ipxeChainHit(zoneId, c.mac));
      }
      const results = await pipeline.exec();
      if (results === null) return null;
      for (const [i, c] of candidates.entries()) {
        const [pxe, chain] = [results[2 * i], results[2 * i + 1]];
        if (pxe?.[1] === 1 || chain?.[1] === 1) return c;
      }
      return null;
    } catch {
      // the tier decides and readMarkers reports the same outage as readError; a probe failure never fails the read
      return null;
    }
  }

  private async readMarkers(zoneId: string, mac: string, deviceId: string): Promise<BootTrail> {
    try {
      const results = await this.redis
        .pipeline()
        .hgetall(deviceRedisKeys.dhcpPxeDecision(zoneId, mac))
        .get(deviceRedisKeys.ipxeChainHit(zoneId, mac))
        .exists(deviceRedisKeys.discoveryPendingFor(zoneId, mac))
        .exec();
      if (results === null) throw new Error('pipeline returned no results');
      const [pxeRaw, chainRaw, pendingRaw] = results.map(([error, value]) => {
        if (error) throw error;
        return value;
      });

      const pxeParsed = PxeDecisionHashSchema.safeParse(pxeRaw);
      const pxe = pxeParsed.success ? { outcome: pxeParsed.data.outcome, atMs: Number(pxeParsed.data.at) } : null;

      const chainExists = typeof chainRaw === 'string';
      const chainHit = chainExists ? parseChainHit(chainRaw) : null;
      const pending = pendingRaw === 1;

      return {
        pxe,
        chainReached: chainExists || pending,
        chainAtMs: chainHit?.atMs ?? null,
        chainDeviceMismatch: chainHit !== null && chainHit.deviceId !== null && chainHit.deviceId !== deviceId,
        readError: null,
      };
    } catch (error) {
      return UNREADABLE(getErrorMessage(error));
    }
  }
}
