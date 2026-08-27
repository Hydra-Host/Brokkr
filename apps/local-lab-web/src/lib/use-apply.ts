import { useState } from 'react';

import { streamPaths, type ApplyAction } from '@/contract';
import { applyRows, type ApplyRow } from '@/features/config/apply-model';
import { tsr } from '@/lib/api';
import { useConfigDirty } from '@/lib/config-dirty';
import { errorMessage, thrownBodyError } from '@/lib/errors';
import { useLogStream } from '@/lib/use-log-stream';
import { useOps } from '@/lib/use-ops';
import { usePoll } from '@/lib/use-poll';
import { useRunTracker } from '@/lib/use-run-tracker';

const PENDING_POLL_MS = 5000;

/** One dispatcher for every config apply. The action comes from APPLY_ACTION, so the UI cannot offer a
 *  run that does not clear the row it sits on. */
export function useApply() {
  const dirtyDomain = useConfigDirty();
  const pending = tsr.getStackPending.useQuery({
    queryKey: ['stack-pending'],
    refetchInterval: usePoll(PENDING_POLL_MS),
  });
  const fleetCfg = tsr.getFleetConfig.useQuery({
    queryKey: ['fleet-config'],
    refetchInterval: usePoll(PENDING_POLL_MS),
  });
  const reloadSvc = tsr.reloadService.useMutation();
  const redeploy = tsr.redeployStack.useMutation();
  const stream = useLogStream();
  const [applyingOf, setApplyingOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tracker = useRunTracker({
    // the detach path passes the run before the API dies, so hold busy until the app reconnects.
    holdOnTerminal: stream.logText.includes('the control-center API is going down now'),
    onTerminal: () => {
      void pending.refetch();
      void fleetCfg.refetch();
    },
  });

  const started = (label: string) => (runId: string) => {
    setError(null);
    setApplyingOf(label);
    tracker.track(runId);
    stream.open(streamPaths.run(runId));
  };
  const failed = (what: string) => (err: unknown) =>
    setError(thrownBodyError(err) ?? errorMessage(err) ?? `${what} failed to start`);

  const ops = useOps(
    'stack',
    (opId, runId) => started(opId)(runId),
    (msg) => setError(msg),
  );

  const readError =
    pending.error != null
      ? (thrownBodyError(pending.error) ?? 'the request failed')
      : pending.data != null && pending.data.status !== 200
        ? `the endpoint answered ${pending.data.status}`
        : null;

  const body = pending.data?.status === 200 ? pending.data.body : null;
  const fleet = fleetCfg.data?.status === 200 ? fleetCfg.data.body.pending : null;
  const rows = applyRows({ pending: body, fleet, dirtyDomain });

  const busy = tracker.active || reloadSvc.isPending || redeploy.isPending || ops.isPending;

  const dispatch = (action: ApplyAction) => {
    if (action.kind === 'reload') {
      reloadSvc.mutate(
        { body: { group: action.group } },
        { onSuccess: (r) => started(`reload ${action.group}`)(r.body.runId), onError: failed('the reload') },
      );
      return;
    }
    if (action.kind === 'redeploy') {
      redeploy.mutate(
        { body: {} },
        { onSuccess: (r) => started('redeploy')(r.body.runId), onError: failed('the redeploy') },
      );
      return;
    }
    const op = ops.allOps.find((o) => o.id === action.opId);
    // the catalog is the authority on destructive and sudo, so an op it does not list is not launched
    // blind — APPLY_ACTION names an id, and only listStackOps says what running it costs.
    if (!op) {
      setError(`the op registry does not list '${action.opId}', so it cannot be launched from here`);
      return;
    }
    ops.onOpClick(op);
  };

  const run = (row: ApplyRow) => {
    if (row.action === null || row.blockedBy !== null || busy) return;
    dispatch(row.action);
  };

  return {
    rows,
    run,
    busy,
    applyingOf,
    error,
    readError,
    seeded: body === null ? null : body.seeded,
    gate: ops.gate,
    stream,
  };
}
