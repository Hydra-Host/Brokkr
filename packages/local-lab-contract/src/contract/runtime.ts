import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import { ZoneRuntimeSchema } from '../schemas/runtime';

export const runtimeRoutes = {
  listZoneRuntimes: {
    method: 'GET',
    path: '/api/runtime/zones',
    responses: { 200: z.array(ZoneRuntimeSchema), 500: ErrorBodySchema },
    summary: 'List per-zone bridge runtime state: leader election, bridge presence, VRRP, zone crypto, agent work',
    description:
      'Read-only: nothing is claimed, bound, enrolled or dispatched, and the zone-crypto key is probed for presence only — its value wraps the zone private key and is never read. One row per configured zone, each assembled from four independent probes so a failure is confined to the section that failed rather than discarding the sections that succeeded; the section carries the reason in its own readError and its fields read null for "could not be determined", which is deliberately distinct from a measured zero, false or empty. Two distinctions matter when reading the result. The leader key is authoritative for who holds the lease, while each bridge\'s own isLeader flag is self-reported on its heartbeat and therefore up to one renew interval stale — a disagreement between them is reported rather than reconciled, because it is usually a failover in flight, and a presence record older than the freshness window is offline even though its key has not expired yet. And VRRP separates intent from fact: desiredHolder is derived from the hub-published atom plus the leader key, whereas observedHolders is a measurement that only exists where bind state is observable at all, so it is null — never an empty array — when the observability field reports "unavailable". Note also that this surface cannot see live-agent gRPC sessions: the bridges hold those in process memory and publish nothing about them, so the agent section reports recent agent work keys instead and must not be read as session liveness.',
  },
} as const;
