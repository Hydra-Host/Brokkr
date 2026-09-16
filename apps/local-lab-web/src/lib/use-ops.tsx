import { useState } from 'react';

import { type GateView } from '@/components/console';
import type { StackOp } from '@/contract';
import { tsr } from '@/lib/api';
import { forceFlipMessage } from '@/lib/apply-run';
import { activeJobsFromBody, errorMessage, responseStatus, thrownBody, thrownBodyError } from '@/lib/errors';
import { useApplyPrompt } from '@/lib/use-apply-confirm';
import { useHostToken } from '@/lib/use-host-token';
import { usePoll } from '@/lib/use-poll';
import { clearRecreating, markRecreating, RECREATE_OP_IDS } from '@/lib/use-restart-state';

export const OPS_POLL_MS = 30_000;

export function useOps(
  section: 'stack' | 'fleet',
  onRun: (opId: string, runId: string) => void,
  onError?: (msg: string) => void,
) {
  // The registry is static, so this interval is purely a recovery poll: reinit/reset/purge take the
  // API down, and a failed fetch otherwise leaves every op section empty until the route remounts.
  const ops = tsr.listStackOps.useQuery({ queryKey: ['stack-ops'], refetchInterval: usePoll(OPS_POLL_MS) });
  const runs = tsr.listRuns.useQuery({
    queryKey: ['runs', 'stack'],
    queryData: { query: { section: 'stack', limit: 100 } },
    refetchInterval: usePoll(2000),
  });
  const sudo = tsr.getSudoStatus.useQuery({ queryKey: ['sudo'], refetchInterval: usePoll(30000) });
  const start = tsr.startStackRun.useMutation();
  const cancelMut = tsr.cancelRun.useMutation();
  const cacheSudo = tsr.cacheSudo.useMutation();
  const hostGate = useHostToken('Caching a sudo password');
  const prompt = useApplyPrompt();

  const [activeOp, setActiveOp] = useState<string | null>(null);
  const [gateOp, setGateOp] = useState<StackOp | null>(null);
  // carried through the sudo gate so a gated fleet-apply keeps the user's data-loss authorization.
  const [gateDataLoss, setGateDataLoss] = useState(false);
  const [password, setPassword] = useState('');
  const [gateError, setGateError] = useState('');

  const sudoReady = sudo.data?.status === 200 ? sudo.data.body.available : false;
  const allOps = ops.data?.status === 200 ? ops.data.body : [];
  const opList = allOps.filter((o) => o.section === section);
  const opIds = new Set(opList.map((o) => o.id));
  const allRuns = runs.data?.status === 200 ? runs.data.body : [];
  const runList = allRuns.filter((r) => opIds.has(r.opId));
  const runningOpIds = new Set(allRuns.filter((r) => r.status === 'running').map((r) => r.opId));
  const activeRun = runList.find((r) => r.status === 'running') ?? null;

  const recreates = (opId: string) => RECREATE_OP_IDS.includes(opId);

  const launch = (opId: string, allowDataLoss = false, force = false) => {
    setActiveOp(opId);
    // stamped before the request: these ops kill this API, so there may be no response to react to.
    if (recreates(opId)) markRecreating(opId);
    start.mutate(
      { body: { opId, allowDataLoss, force } },
      {
        onSuccess: (res) => {
          onRun(opId, res.body.runId);
          void runs.refetch();
        },
        onError: (e) => {
          // a refused launch keeps neither the ring highlight nor the stamp; the server marker is
          // authoritative for a recreation that really is in flight, and it just answered us.
          setActiveOp(null);
          if (recreates(opId)) clearRecreating();
          const activeJobs = responseStatus(e) === 409 ? activeJobsFromBody(thrownBody(e)) : 0;
          if (activeJobs > 0) {
            // only the fleet-planes flip answers 409 with activeJobs; every launcher gets the same gate
            void prompt(forceFlipMessage(activeJobs)).then((ok) => {
              if (ok) launch(opId, allowDataLoss, true);
            });
            return;
          }
          const msg = thrownBodyError(e) ?? 'start failed';
          if (msg) onError?.(msg);
        },
      },
    );
  };

  const cancelRun = (runId: string) =>
    cancelMut.mutate(
      { params: { runId }, body: {} },
      {
        onSuccess: () => void runs.refetch(),
        onError: (e) => onError?.(`cancel failed — ${errorMessage(e) ?? 'request failed'}`),
      },
    );

  const onOpClick = (op: StackOp, allowDataLoss = false) => {
    if (op.destructive || (op.needsSudo && !sudoReady)) {
      setGateOp(op);
      setGateDataLoss(allowDataLoss);
      setPassword('');
      setGateError('');
    } else {
      launch(op.id, allowDataLoss);
    }
  };

  const confirmGate = () => {
    if (!gateOp) return;
    if (gateOp.needsSudo && !sudoReady) {
      if (hostGate.blocked) {
        hostGate.ask();
        setGateOp(null);
        return;
      }
      cacheSudo.mutate(
        { body: { password }, extraHeaders: { 'x-lab-token': hostGate.token } },
        {
          onSuccess: (res) => {
            if (res.status === 200 && res.body.ok) {
              void sudo.refetch();
              launch(gateOp.id, gateDataLoss);
              setGateOp(null);
              setPassword('');
            } else if (hostGate.noteRefusal(res.status, res.body)) {
              setGateOp(null);
            } else {
              setGateError('sudo password rejected');
            }
          },
          // the ts-rest client rejects every non-2xx, so a 401 rejection and a 429 throttle both land
          // here — surface the server's own message, which names the cooldown's seconds remaining.
          onError: (err: unknown) => {
            // the prompt replaces the gate: it renders outside the modal, which would cover it
            if (hostGate.noteThrownRefusal(err)) {
              setGateOp(null);
              return;
            }
            setGateError(thrownBodyError(err) ?? 'failed to validate sudo');
          },
        },
      );
    } else {
      launch(gateOp.id, gateDataLoss);
      setGateOp(null);
    }
  };

  const gate: GateView | null = gateOp
    ? {
        label: gateOp.label,
        destructive: gateOp.destructive,
        description: (
          <>
            This tears down / wipes state. <span className="font-mono">task {gateOp.task}</span>
          </>
        ),
        needsPassword: gateOp.needsSudo && !sudoReady,
        password,
        setPassword,
        error: gateError,
        busy: cacheSudo.isPending,
        confirm: confirmGate,
        cancel: () => setGateOp(null),
      }
    : null;

  return {
    opList,
    allOps,
    // a dead query renders identically to an empty registry, so the caller needs both to tell them
    // apart; errText's shape is what the shared ErrorBanner consumes.
    opsData: ops.data,
    opsError: ops.error,
    runList,
    runningOpIds,
    activeOp,
    activeRun,
    isPending: start.isPending,
    sudoReady,
    gate,
    hostTokenDialog: hostGate.dialog,
    onOpClick,
    cancelRun,
  };
}
