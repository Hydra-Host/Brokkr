import { tsr } from '@/lib/api';
import { usePoll } from '@/lib/use-poll';

import { buildTopology, type TopologyModel } from './fleet-topology';

// matches the live fleet page, and the zone poll sits under the bridges' 10s leader renew so a
// failover shows on the graph while it is still in flight
const MACHINE_POLL_MS = 4000;
const RUNTIME_POLL_MS = 5000;

/** A settled non-200 or a thrown error is a failure; anything else has simply not answered yet, which
 *  the model must not report as an unreadable source. */
function unready(
  data: { status: number } | undefined,
  error: unknown,
  what: string,
): { state: 'loading' } | { state: 'failed'; error: string } {
  if (error != null) return { state: 'failed', error: `the ${what} request failed` };
  if (data != null) return { state: 'failed', error: `the ${what} endpoint answered ${data.status}` };
  return { state: 'loading' };
}

export function useFleetTopology(): { model: TopologyModel; isPending: boolean } {
  const zones = tsr.getZonesConfig.useQuery({ queryKey: ['zones-config'] });
  const fleet = tsr.getFleetConfig.useQuery({ queryKey: ['fleet-config'] });
  const machines = tsr.listMachines.useQuery({ queryKey: ['machines'], refetchInterval: usePoll(MACHINE_POLL_MS) });
  const runtime = tsr.listZoneRuntimes.useQuery({
    queryKey: ['zone-runtime'],
    refetchInterval: usePoll(RUNTIME_POLL_MS),
  });

  const model = buildTopology({
    zones:
      zones.data?.status === 200
        ? { state: 'ready', value: zones.data.body }
        : unready(zones.data, zones.error, 'zone config'),
    fleet:
      fleet.data?.status === 200
        ? { state: 'ready', value: { nodes: fleet.data.body.nodes, baremetal: fleet.data.body.baremetal } }
        : unready(fleet.data, fleet.error, 'fleet config'),
    machines:
      machines.data?.status === 200
        ? { state: 'ready', value: machines.data.body }
        : unready(machines.data, machines.error, 'machine list'),
    runtime:
      runtime.data?.status === 200
        ? { state: 'ready', value: runtime.data.body }
        : unready(runtime.data, runtime.error, 'zone runtime'),
  });

  return { model, isPending: model.loading };
}
