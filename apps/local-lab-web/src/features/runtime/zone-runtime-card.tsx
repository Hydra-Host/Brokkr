import { Unknown } from '@/components/ui/unknown';
import type { ZoneBridge, ZoneRuntime, ZoneVip } from '@/contract';
import { fmtAgo } from '@/lib/format';

import { CRYPTO_TONE, leaderDisagrees, UNKNOWN_TITLE, vipAgreement } from './zone-runtime-health';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="text-text-dim w-20 shrink-0 tracking-wide uppercase">{label}</span>
      <span className="text-text-primary min-w-0 font-mono break-words">{children}</span>
    </div>
  );
}

function SectionError({ children }: { children: React.ReactNode }) {
  return <span className="text-status-offline">unreadable — {children}</span>;
}

function BridgeLine({ bridge }: { bridge: ZoneBridge }) {
  const state = bridge.online === null ? null : bridge.online;
  return (
    <span className="mr-3 inline-flex items-center gap-1">
      <span
        className={`h-1.5 w-1.5 rounded-full ${state === null ? 'bg-text-dim' : state ? 'bg-status-online' : 'bg-status-offline'}`}
      />
      <span>{bridge.instanceId}</span>
      {bridge.isLeader === true && <span className="text-status-info">leader</span>}
      {bridge.isLeader === null && bridge.registered && <Unknown title={UNKNOWN_TITLE.isLeader} />}
      {!bridge.registered && (
        <span
          className="text-status-warning"
          title="configured for this zone but no presence record — it never registered or its record expired"
        >
          unregistered
        </span>
      )}
      {!bridge.expected && (
        <span
          className="text-status-warning"
          title="registered without being declared in the stack config for this zone"
        >
          undeclared
        </span>
      )}
    </span>
  );
}

function VipLine({ vip }: { vip: ZoneVip }) {
  const agreement = vipAgreement(vip);
  if (agreement === 'unknown') {
    return (
      <span className="block">
        <span className="text-text-dim">{vip.prefixId}</span> <SectionError>{vip.atomError}</SectionError>
      </span>
    );
  }
  return (
    <span className="block">
      {vip.vip} <span className="text-text-dim">want {vip.desiredHolder ?? 'nobody'}</span>{' '}
      {agreement === 'unobserved' ? (
        <Unknown title={UNKNOWN_TITLE.observed} />
      ) : (
        <span className={agreement === 'agrees' ? 'text-status-online' : 'text-status-offline'}>
          have {vip.observedHolders?.length === 0 ? 'nobody' : vip.observedHolders?.join(', ')}
        </span>
      )}
    </span>
  );
}

export function ZoneRuntimeCard({ zone, nowMs = Date.now() }: { zone: ZoneRuntime; nowMs?: number }) {
  const disagreement = leaderDisagrees(zone);
  return (
    <div className="border-border-dim bg-bg-secondary space-y-1.5 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-text-primary font-mono text-sm">{zone.zoneName ?? zone.zoneId}</span>
        {zone.readError !== null && <SectionError>{zone.readError}</SectionError>}
      </div>

      {zone.readError === null && (
        <>
          <Row label="leader">
            {zone.leader.readError !== null ? (
              <SectionError>{zone.leader.readError}</SectionError>
            ) : zone.leader.holder === null ? (
              <span className="text-status-warning">unheld</span>
            ) : (
              <>
                {zone.leader.holder}
                {zone.leader.ttlSeconds !== null && (
                  <span className="text-text-dim"> · {zone.leader.ttlSeconds}s left</span>
                )}
                {disagreement && (
                  <span
                    className="text-status-warning ml-1"
                    title="a bridge still reports itself leader while the lease names another — usually a failover in flight"
                  >
                    contested
                  </span>
                )}
              </>
            )}
          </Row>

          <Row label="bridges">
            {zone.bridges.readError !== null ? (
              <SectionError>{zone.bridges.readError}</SectionError>
            ) : zone.bridges.rows.length === 0 ? (
              <span className="text-text-dim">none</span>
            ) : (
              zone.bridges.rows.map((bridge) => <BridgeLine key={bridge.instanceId} bridge={bridge} />)
            )}
          </Row>

          <Row label="vrrp">
            {zone.vrrp.readError !== null ? (
              <SectionError>{zone.vrrp.readError}</SectionError>
            ) : zone.vrrp.vips.length === 0 ? (
              <span className="text-text-dim">no vip configured</span>
            ) : (
              zone.vrrp.vips.map((vip) => <VipLine key={vip.prefixId} vip={vip} />)
            )}
          </Row>

          <Row label="crypto">
            {zone.zoneCrypto.readError !== null ? (
              <SectionError>{zone.zoneCrypto.readError}</SectionError>
            ) : (
              <span className={CRYPTO_TONE[zone.zoneCrypto.state]}>
                {zone.zoneCrypto.state}
                {zone.zoneCrypto.bootstrapLockTtlSeconds !== null && (
                  <span className="text-text-dim"> · lock {zone.zoneCrypto.bootstrapLockTtlSeconds}s</span>
                )}
              </span>
            )}
          </Row>

          <Row label="agents">
            {zone.agentWork.readError !== null ? (
              <SectionError>{zone.agentWork.readError}</SectionError>
            ) : (
              <>
                {zone.agentWork.dispatchesInFlight ?? <Unknown title={UNKNOWN_TITLE.agentWork} />} dispatched
                <span className="text-text-dim">
                  {' · '}
                  {zone.agentWork.lastActivityAtMs === null
                    ? 'no work seen'
                    : fmtAgo(zone.agentWork.lastActivityAtMs, nowMs)}
                </span>
                {zone.agentWork.scanCapped && (
                  <span
                    className="text-status-warning ml-1"
                    title="the key scan hit its cap, so this is a floor rather than a complete count"
                  >
                    capped
                  </span>
                )}
              </>
            )}
          </Row>
        </>
      )}
    </div>
  );
}
