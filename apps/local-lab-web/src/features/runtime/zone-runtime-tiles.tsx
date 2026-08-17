import { Tile } from '@/components/ui/tile';
import { fmtAgo } from '@/lib/format';

import { useZoneRuntime } from './use-zone-runtime';
import { summarizeZoneRuntime, undeterminedNote } from './zone-runtime-health';

export function ZoneRuntimeTiles({ nowMs = Date.now() }: { nowMs?: number }) {
  const { zones, error } = useZoneRuntime();
  if (error !== null || zones === null) return null;

  const totals = summarizeZoneRuntime(zones);
  // every denominator counts only the zones actually measured, so an undetermined zone is never
  // folded in as a zone that failed the check it could not be asked.
  const ledMeasured = totals.zones - totals.leaderUndetermined;
  const cryptoMeasured = totals.zones - totals.cryptoUndetermined;
  const vipNotes = [
    totals.vipsUnobserved > 0 ? `${totals.vipsUnobserved} unobserved` : null,
    totals.vipsUnreadable > 0 ? `${totals.vipsUnreadable} unreadable` : null,
    totals.vrrpUndetermined > 0 ? `${totals.vrrpUndetermined} zone(s) unread` : null,
  ].filter((note): note is string => note !== null);

  return (
    // two-up, not four: this row lives in the 320px rail, and md: is a viewport breakpoint, not a
    // container one, so md:grid-cols-4 would give each tile ~74px on any normal screen.
    <div className="grid grid-cols-2 gap-2">
      <Tile
        label="Zones led"
        value={`${totals.zonesWithLeader}/${ledMeasured}`}
        sub={
          undeterminedNote(totals.leaderUndetermined) ??
          (ledMeasured === 0
            ? 'no zone measured'
            : totals.zonesWithLeader === ledMeasured
              ? 'every zone holds a lease'
              : `${ledMeasured - totals.zonesWithLeader} unheld`)
        }
      />
      <Tile
        label="VIPs"
        value={
          totals.vipsDiverging > 0 ? (
            <span className="text-status-offline">{totals.vipsDiverging} diverging</span>
          ) : totals.vipsAgreeing === 0 && totals.vrrpUndetermined > 0 ? (
            <span className="text-text-dim">undetermined</span>
          ) : (
            `${totals.vipsAgreeing} as intended`
          )
        }
        sub={vipNotes.length > 0 ? vipNotes.join(' · ') : undefined}
      />
      <Tile
        label="Zone crypto"
        value={
          totals.zonesNotEnrolled > 0 ? (
            <span className="text-status-warning">{totals.zonesNotEnrolled} not enrolled</span>
          ) : totals.zonesBootstrapping > 0 ? (
            <span className="text-status-info">{totals.zonesBootstrapping} bootstrapping</span>
          ) : cryptoMeasured === 0 ? (
            <span className="text-text-dim">undetermined</span>
          ) : (
            'enrolled'
          )
        }
        sub={undeterminedNote(totals.cryptoUndetermined) ?? undefined}
      />
      <Tile
        label="Agent work"
        value={totals.lastAgentActivityAtMs === null ? 'none seen' : fmtAgo(totals.lastAgentActivityAtMs, nowMs)}
        sub={undeterminedNote(totals.agentWorkUndetermined) ?? undefined}
      />
    </div>
  );
}
