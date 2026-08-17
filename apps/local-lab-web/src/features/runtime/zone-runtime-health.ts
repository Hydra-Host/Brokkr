import type { ZoneRuntime, ZoneVip } from '@/contract';

export { UNKNOWN } from '@/components/ui/unknown';

export const UNKNOWN_TITLE: Record<string, string> = {
  leader: 'the leader key could not be read — which is not the same as no bridge holding the lease',
  online: 'this bridge published no readable presence record, so its liveness could not be determined',
  isLeader: 'this bridge published no readable leader flag, which is not the same as it being a follower',
  observed: 'VIP bind state is not observable here, which is not the same as no bridge holding the address',
  agentWork: 'the agent work keys could not be scanned, which is not the same as no agent work',
};

export type VipAgreement = 'agrees' | 'diverges' | 'unobserved' | 'unknown';

/** Intent versus fact. A persistent divergence is the failure worth alarming on (a stuck or
 *  split-brain VIP); an unobserved VIP is a gap in the observer, not a fact about the zone. */
export function vipAgreement(vip: ZoneVip): VipAgreement {
  if (vip.atomError !== null) return 'unknown';
  if (vip.observedHolders === null) return 'unobserved';
  const desired = vip.desiredHolder === null ? [] : [vip.desiredHolder];
  const observed = [...vip.observedHolders].sort();
  return desired.length === observed.length && desired.every((holder, i) => holder === observed[i])
    ? 'agrees'
    : 'diverges';
}

export const leaderDisagrees = (zone: ZoneRuntime): boolean =>
  zone.leader.readError === null &&
  zone.bridges.rows.some((bridge) => bridge.isLeader === true && bridge.instanceId !== zone.leader.holder);

export interface ZoneRuntimeTotals {
  zones: number;
  zonesWithLeader: number;
  leaderUndetermined: number;
  vipsAgreeing: number;
  vipsDiverging: number;
  vipsUnobserved: number;
  vipsUnreadable: number;
  vrrpUndetermined: number;
  zonesBootstrapping: number;
  zonesNotEnrolled: number;
  cryptoUndetermined: number;
  lastAgentActivityAtMs: number | null;
  agentWorkUndetermined: number;
}

/** Undetermined rows are counted separately, never folded into a total — a zone whose leader key
 *  could not be read must not be reported as a zone with no leader. */
export function summarizeZoneRuntime(zones: ZoneRuntime[]): ZoneRuntimeTotals {
  const totals: ZoneRuntimeTotals = {
    zones: zones.length,
    zonesWithLeader: 0,
    leaderUndetermined: 0,
    vipsAgreeing: 0,
    vipsDiverging: 0,
    vipsUnobserved: 0,
    vipsUnreadable: 0,
    vrrpUndetermined: 0,
    zonesBootstrapping: 0,
    zonesNotEnrolled: 0,
    cryptoUndetermined: 0,
    lastAgentActivityAtMs: null,
    agentWorkUndetermined: 0,
  };

  for (const zone of zones) {
    if (zone.readError !== null || zone.leader.readError !== null) totals.leaderUndetermined += 1;
    else if (zone.leader.holder !== null) totals.zonesWithLeader += 1;

    // a zone whose whole vrrp section failed reports no vips at all, so without its own counter it
    // would contribute nothing and the rollup would read as healthy for a zone it never measured
    if (zone.vrrp.readError !== null || zone.readError !== null) totals.vrrpUndetermined += 1;

    for (const vip of zone.vrrp.vips) {
      const agreement = vipAgreement(vip);
      if (agreement === 'agrees') totals.vipsAgreeing += 1;
      else if (agreement === 'diverges') totals.vipsDiverging += 1;
      else if (agreement === 'unobserved') totals.vipsUnobserved += 1;
      else totals.vipsUnreadable += 1;
    }

    if (zone.zoneCrypto.state === 'unknown') totals.cryptoUndetermined += 1;
    else if (zone.zoneCrypto.state === 'not-enrolled') totals.zonesNotEnrolled += 1;
    else if (zone.zoneCrypto.state === 'bootstrapping') totals.zonesBootstrapping += 1;

    if (zone.agentWork.readError !== null) totals.agentWorkUndetermined += 1;
    const seen = zone.agentWork.lastActivityAtMs;
    if (seen !== null && (totals.lastAgentActivityAtMs === null || seen > totals.lastAgentActivityAtMs)) {
      totals.lastAgentActivityAtMs = seen;
    }
  }
  return totals;
}

/** Per counter, never summed: one zone whose whole read failed increments leader, crypto and agent
 *  work alike, so adding them would report three excluded zones where there is one. */
export const undeterminedNote = (count: number): string | null =>
  count === 0 ? null : `excludes ${count} undetermined`;

export const CRYPTO_TONE: Record<ZoneRuntime['zoneCrypto']['state'], string> = {
  enrolled: 'text-status-online',
  bootstrapping: 'text-status-info',
  'not-enrolled': 'text-status-warning',
  unknown: 'text-text-dim',
};
