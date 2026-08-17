import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import {
  AnsiLogPane,
  DatastoreCard,
  GateModal,
  OpList,
  RecentRuns,
  SectionHeading,
  SvcBtn,
} from '@/components/console';
import { FleetStatusCard } from '@/components/fleet-status';
import { PendingBanner } from '@/components/pending-banner';
import { VmConsole } from '@/components/terminal';
import { streamPaths, type ExecResult, type Machine, type StackOp, type VerifyFinding } from '@/contract';
import { ErrorBanner, errText } from '@/features/datastore/shared/error-banner';
import { ZoneRuntimeSection } from '@/features/runtime';
import { tsr } from '@/lib/api';
import { useApplyPending } from '@/lib/apply-run';
import { deviceQueuesSearch } from '@/lib/datastore-search';
import { bodyError, errorMessage } from '@/lib/errors';
import { deviceTokensSearch } from '@/lib/hub-search';
import { reportControl } from '@/lib/report-control';
import { useToast } from '@/lib/toast';
import { useApplyConfirm } from '@/lib/use-apply-confirm';
import { awaitFleetRun, useLogStream } from '@/lib/use-log-stream';
import { OPS_POLL_MS, useOps } from '@/lib/use-ops';

function FleetPage() {
  const stream = useLogStream();
  const toast = useToast();
  const { confirmApply } = useApplyConfirm();
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [activeProc, setActiveProc] = useState<string | null>(null);
  const ops = useOps(
    'fleet',
    (_opId, runId) => {
      setActiveProc(null);
      setSelectedRun(runId);
      stream.open(streamPaths.run(runId));
    },
    (msg) => toast.error(msg),
  );
  const { apply: applyPending, isPending: applyBusy } = useApplyPending(
    (runId) => {
      setActiveProc(null);
      setSelectedRun(runId);
      stream.open(streamPaths.run(runId));
    },
    (msg) => toast.error(msg),
  );

  const machines = tsr.listMachines.useQuery({ queryKey: ['machines'], refetchInterval: 4000 });
  const stackState = tsr.getStackState.useQuery({ queryKey: ['stack-state'], refetchInterval: 3000 });
  const verify = tsr.getFleetVerify.useQuery({ queryKey: ['fleet-verify'], refetchInterval: 30000 });
  const power = tsr.powerMachine.useMutation();
  const reset = tsr.resetMachine.useMutation();
  const heal = tsr.healFleet.useMutation();
  const discover = tsr.discoverMachine.useMutation();
  const controlDs = tsr.controlDatastore.useMutation();
  // lifted out of ExecModal so `busy` can lock the cards while an SSH exec is still in flight
  // (closing the modal must not re-enable power/reset on the node mid-command).
  const exec = tsr.execMachine.useMutation();
  const [consoleNode, setConsoleNode] = useState<string | null>(null);
  // node awaiting the destructive reset confirm, and the node whose exec modal is open.
  const [resetNode, setResetNode] = useState<string | null>(null);
  const [execNode, setExecNode] = useState<string | null>(null);
  // heal outlives its POST (fleet lease + SSE run persist), so a re-click during the run 409s;
  // hold the button until awaitFleetRun settles.
  const [healRunning, setHealRunning] = useState(false);

  const viewRun = (runId: string) => {
    setActiveProc(null);
    setSelectedRun(runId);
    setConsoleNode(null);
    stream.open(streamPaths.run(runId));
  };

  const machineList = machines.data?.status === 200 ? machines.data.body : [];
  const stackBody = stackState.data?.status === 200 ? stackState.data.body : undefined;
  const fleetProcesses = stackBody?.fleetProcesses ?? [];
  const fleetPending = stackBody?.fleetPending;

  const fleet = stackBody?.fleet;
  const comingUp = fleet?.health === 'coming-up';
  const expectedSlots = fleet ? Array.from({ length: fleet.machinesExpected }, (_v, i) => i) : [];
  const startFleet = () => {
    const op = ops.opList.find((o) => o.id === 'fleet-up');
    if (op) ops.onOpClick(op);
  };

  const viewFleetLogs = () => {
    setActiveProc(null);
    setSelectedRun(null);
    setConsoleNode(null);
    stream.open(streamPaths.fleetProcessLogs(), { finite: false });
  };
  useEffect(() => {
    stream.open(streamPaths.fleetProcessLogs(), { finite: false }); // once on mount; runs/console re-point the single pane
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configuredNames = machineList.filter((m) => m.configured).map((m) => m.name);
  const bringupFor = (m: Machine): { state: 'pending' | 'active' | 'done'; label?: string } | undefined => {
    if (!comingUp || !m.configured || m.power !== 'unknown') return undefined;
    if (fleet?.node === m.name) return { state: 'active', label: fleet.label ?? undefined };
    if (fleet && fleet.index > 0) {
      const pos = configuredNames.indexOf(m.name) + 1;
      if (pos > 0 && pos < fleet.index) return { state: 'done' };
      if (pos > fleet.index) return { state: 'pending' };
    }
    return { state: 'active', label: fleet?.label ?? undefined };
  };

  const viewProc = (id: string) => {
    setActiveProc(id);
    setSelectedRun(null);
    setConsoleNode(null);
    stream.open(`/api/stack/datastores/${id}/log`, { finite: false });
  };

  const controlProc = (id: string, action: 'start' | 'stop' | 'restart') => {
    controlDs.mutate(
      { body: { id, action } },
      {
        onSuccess: (data) => {
          reportControl(toast, id, action, data);
          setTimeout(() => void stackState.refetch(), 1000);
          if (action !== 'stop') viewProc(id);
        },
        onError: (e) => toast.error(`${id}: ${action} — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  // reset/rediscover/power/heal all create a fleet run and stream its output — same {runId}→SSE path.
  const streamFleetRun = (runId: string) => {
    setActiveProc(null);
    // drop any open console so the run output isn't streamed under the VmConsole overlay (it covers
    // the pane) — matches viewRun/viewProc/viewFleetLogs.
    setConsoleNode(null);
    // highlight this run in Recent runs instead of leaving a previously selected run lit.
    setSelectedRun(runId);
    stream.open(streamPaths.run(runId));
    setTimeout(() => void machines.refetch(), 1500);
  };

  const onPower = (name: string, action: 'on' | 'off' | 'cycle') => {
    if (power.isPending) return; // double-click guard — the busy prop disables one render later
    power.mutate(
      { body: { name, action } },
      {
        onSuccess: (res) => {
          if (res.status !== 200) {
            toast.error(bodyError(res.body) ?? `power ${action} failed (${res.status})`);
            return;
          }
          streamFleetRun(res.body.runId);
        },
        onError: (e) => toast.error(`power ${action} — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  const onReset = (name: string) => {
    reset.mutate(
      { body: { name } },
      {
        onSuccess: (res) => {
          if (res.status !== 200) {
            toast.error(bodyError(res.body) ?? `reset failed (${res.status})`);
            return;
          }
          streamFleetRun(res.body.runId);
        },
        onError: (e) => toast.error(`reset — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  const onDiscover = (name: string) => {
    if (discover.isPending) return; // double-click guard — the busy prop disables one render later
    discover.mutate(
      { body: { name } },
      {
        onSuccess: (res) => {
          if (res.status !== 200) {
            toast.error(bodyError(res.body) ?? `rediscover failed (${res.status})`);
            return;
          }
          streamFleetRun(res.body.runId);
        },
        onError: (e) => toast.error(`rediscover — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  const onHeal = () => {
    if (heal.isPending || healRunning) return; // guard the whole run, not just the POST
    heal.mutate(
      { body: {} },
      {
        onSuccess: (res) => {
          if (res.status !== 200) {
            toast.error(bodyError(res.body) ?? `heal failed (${res.status})`);
            return;
          }
          setHealRunning(true);
          streamFleetRun(res.body.runId);
          // decoupled from the log pane: the shared stream can be switched mid-heal, so watch the run's
          // own completion to refresh the verify report.
          void awaitFleetRun(res.body.runId).then(() => {
            setHealRunning(false);
            void verify.refetch();
          });
        },
        onError: (e) => toast.error(`heal — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  const verifyBody = verify.data?.status === 200 ? verify.data.body : undefined;
  const machineNameSet = new Set(machineList.map((m) => m.name));
  const findingsByMachine = new Map<string, VerifyFinding[]>();
  const fleetFindings: VerifyFinding[] = [];
  for (const f of verifyBody?.findings ?? []) {
    // node-level findings whose node is a live machine chip on its card; the rest (fleet-level nulls +
    // orphan domains for machines not in config) collect into the compact card above the list.
    if (f.node && machineNameSet.has(f.node)) {
      const arr = findingsByMachine.get(f.node) ?? [];
      arr.push(f);
      findingsByMachine.set(f.node, arr);
    } else {
      fleetFindings.push(f);
    }
  }
  const anyHealable = (verifyBody?.findings ?? []).some((f) => f.healable);

  const gatedText = (_op: StackOp) => null;
  // fleet-apply can wipe a node disk; the op-list button must go through the same confirm as the banner/Settings.
  const launchOp = async (op: StackOp) => {
    if (op.id === 'fleet-apply') {
      const { proceed, allowDataLoss } = await confirmApply();
      if (!proceed) return;
      ops.onOpClick(op, allowDataLoss);
      return;
    }
    ops.onOpClick(op);
  };
  const byGroup = (g: StackOp['group']) => ops.opList.filter((o) => o.group === g);
  const opsFailure = ops.allOps.length === 0 ? errText(ops.opsData, ops.opsError) : null;
  const opListProps = { activeOp: ops.activeOp, disabled: ops.isPending, gatedText, onOpClick: launchOp };

  return (
    <div className="relative grid grid-cols-1 gap-6 lg:h-[calc(100dvh-7rem)] lg:grid-cols-[320px_1fr]">
      {ops.gate && <GateModal gate={ops.gate} />}
      {resetNode && (
        <GateModal
          gate={{
            label: `Reset ${resetNode} to inventory`,
            destructive: true,
            description: (
              <>
                Wipes the node back to a clean INVENTORY state — closes its active reservations and deployments, sets
                the server to INVENTORY, and clears job history + spoke Redis atoms. The VM itself is left as-is.
              </>
            ),
            needsPassword: false,
            password: '',
            setPassword: () => {},
            error: '',
            // pending-guarded like ExecModal: a rapid double-confirm must not start two concurrent
            // destructive resets for the same node.
            busy: reset.isPending,
            confirmLabel: 'Reset node',
            confirm: () => {
              if (reset.isPending) return;
              const name = resetNode;
              setResetNode(null);
              onReset(name);
            },
            cancel: () => setResetNode(null),
          }}
        />
      )}
      {execNode && <ExecModal key={execNode} node={execNode} exec={exec} onClose={() => setExecNode(null)} />}
      <div className="space-y-4 pr-1 lg:min-h-0 lg:overflow-auto">
        <SectionHeading>Fleet</SectionHeading>
        <p className="text-text-dim text-[11px]">
          The simulated hardware (libvirt VMs + vbmc + sushy). Fleet up needs the stack running first (fleet:init seeds
          against the live hub).
        </p>
        {opsFailure && (
          <ErrorBanner>
            op list unavailable — {opsFailure}. every section below is empty for that reason, not because there is
            nothing to run; retrying every {OPS_POLL_MS / 1000}s.
          </ErrorBanner>
        )}

        <SectionHeading>Status</SectionHeading>
        {fleet && (
          <FleetStatusCard fleet={fleet} busy={ops.isPending} onStart={startFleet} onViewLogs={viewFleetLogs} />
        )}
        <OpList ops={byGroup('status')} {...opListProps} />
        {fleetPending && (
          <PendingBanner
            pending={fleetPending}
            busy={applyBusy || !!ops.activeRun}
            onApply={() => void applyPending(fleetPending.severity === 'mode-change')}
          />
        )}
        {verifyBody?.status === 'findings' && (
          <VerifyFindingsCard
            findings={fleetFindings}
            total={verifyBody.summary.findings}
            anyHealable={anyHealable}
            healing={heal.isPending || healRunning}
            onHeal={onHeal}
          />
        )}
        <ZoneRuntimeSection />
        <div className="space-y-2">
          {machineList.map((m) => (
            <MachineCard
              key={m.name}
              machine={m}
              findings={findingsByMachine.get(m.name)}
              bringup={bringupFor(m)}
              busy={power.isPending || reset.isPending || discover.isPending || exec.isPending || resetNode === m.name}
              onPower={(action) => onPower(m.name, action)}
              onConsole={() => {
                setActiveProc(null);
                setConsoleNode(m.name);
              }}
              onReset={() => setResetNode(m.name)}
              onDiscover={() => onDiscover(m.name)}
              onExec={() => {
                // fresh pane only when switching nodes — reopening the same node must keep a result
                // that finished while the modal was closed (success has no toast to fall back on).
                if (exec.variables?.body.name !== m.name) exec.reset();
                setExecNode(m.name);
              }}
            />
          ))}
          {machineList.length === 0 &&
            comingUp &&
            expectedSlots.map((i) => (
              <div
                key={`pending-${i}`}
                className="border-border-dim text-text-dim flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="bg-accent/60 h-2 w-2 animate-pulse rounded-full" /> coming up…
              </div>
            ))}
          {machineList.length === 0 && !comingUp && (
            <div className="text-text-dim text-xs">no machines (fleet down?)</div>
          )}
        </div>

        {fleetProcesses.length > 0 && (
          <div className="space-y-2">
            <SectionHeading>Processes</SectionHeading>
            {fleetProcesses.map((p) => (
              <DatastoreCard
                key={p.id}
                ds={p}
                active={activeProc === p.id}
                busy={controlDs.isPending}
                onView={() => viewProc(p.id)}
                onControl={(action) => controlProc(p.id, action)}
              />
            ))}
          </div>
        )}

        <div className="pt-2">
          <SectionHeading>Bring up</SectionHeading>
        </div>
        <OpList ops={byGroup('bringup')} {...opListProps} />

        <div className="pt-2">
          <SectionHeading>Destructive</SectionHeading>
        </div>
        <OpList
          ops={byGroup('destructive')}
          {...opListProps}
          forceDisabled={comingUp}
          disabledReason="Fleet is coming up — stopping now tears down the in-progress bring-up; wait for ready."
        />

        <div className="pt-2">
          <SectionHeading>Recent runs</SectionHeading>
        </div>
        <RecentRuns runs={ops.runList} onSelect={viewRun} activeId={selectedRun} />
      </div>

      <div className="relative flex min-h-0 flex-col">
        <div className="mb-2">
          <SectionHeading>{consoleNode ? 'Console' : 'Logs'}</SectionHeading>
        </div>
        <AnsiLogPane
          logHtml={stream.logHtml}
          logRef={stream.logRef}
          placeholder="Run a fleet op or power a VM to stream output; open a console from a machine card."
          tail={{ on: stream.follow, toggle: () => stream.setFollow(!stream.follow) }}
          clear={stream.clear}
          degraded={stream.degraded}
          disconnected={stream.disconnected}
        />
        {consoleNode && <VmConsole node={consoleNode} onClose={() => setConsoleNode(null)} />}
      </div>
    </div>
  );
}

/** Compact verify summary above the machine list: fleet-level + orphan findings, plus a heal button
 *  when any finding (node-level too) is repairable in place. Non-healable ones read as needs-apply. */
function VerifyFindingsCard({
  findings,
  total,
  anyHealable,
  healing,
  onHeal,
}: {
  findings: VerifyFinding[];
  total: number;
  anyHealable: boolean;
  healing: boolean;
  onHeal: () => void;
}) {
  return (
    <div className="border-status-warning/30 bg-status-warning/5 space-y-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-status-warning/90 text-xs font-medium">
          Fleet verify: {total} finding{total === 1 ? '' : 's'}
        </span>
        {anyHealable && (
          <button
            onClick={onHeal}
            disabled={healing}
            className="border-accent/30 text-accent hover:bg-accent/10 rounded border px-2 py-1 text-[11px] disabled:opacity-50"
          >
            {healing ? 'healing…' : 'heal'}
          </button>
        )}
      </div>
      {findings.length > 0 && (
        <ul className="space-y-1">
          {findings.map((f, i) => (
            <li key={`${f.node ?? 'fleet'}-${f.kind}-${i}`} className="text-text-dim text-[11px]">
              <span className="text-text-label font-mono">{f.node ?? 'fleet'}</span>: {f.detail}
              {!f.healable && <span className="text-status-warning/70"> (needs apply)</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MachineCard({
  machine,
  findings,
  bringup,
  busy,
  onPower,
  onConsole,
  onReset,
  onDiscover,
  onExec,
}: {
  machine: Machine;
  findings?: VerifyFinding[];
  bringup?: { state: 'pending' | 'active' | 'done'; label?: string };
  busy: boolean;
  onPower: (action: 'on' | 'off' | 'cycle') => void;
  onConsole: () => void;
  onReset: () => void;
  onDiscover: () => void;
  onExec: () => void;
}) {
  const { deviceId } = machine;
  const on = machine.power === 'on';
  const dot = bringup
    ? bringup.state === 'active'
      ? 'bg-accent animate-pulse'
      : bringup.state === 'done'
        ? 'bg-status-online/70'
        : 'bg-text-label'
    : on
      ? 'bg-status-online'
      : machine.power === 'off'
        ? 'bg-text-dim'
        : 'bg-status-warning';
  const statusText = bringup ? (bringup.label ?? bringup.state) : machine.power;
  const locked = busy || !!bringup;
  return (
    <div className="border-border-dim rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="text-text-primary font-mono font-medium">{machine.name}</span>
          {!machine.configured && (
            <span
              title="Running, but not in the active fleet config — likely a rename/edit pending a Rebuild, or a fleet from another checkout."
              className="border-status-warning/30 text-status-warning/70 rounded border px-1 py-0.5 text-[9px]"
            >
              not in config
            </span>
          )}
          {findings && findings.length > 0 && (
            <span
              title={findings.map((f) => f.detail).join('; ')}
              className="border-status-warning/30 text-status-warning/70 rounded border px-1 py-0.5 text-[9px]"
            >
              ⚠ {findings.length}
            </span>
          )}
        </div>
        <span className="text-text-dim shrink-0 truncate text-[11px]" title={statusText}>
          {statusText}
        </span>
      </div>
      <div className="mt-2 flex gap-1.5 text-[11px]">
        <SvcBtn label="on" disabled={locked || on} onClick={() => onPower('on')} />
        <SvcBtn label="cycle" disabled={locked || !on} onClick={() => onPower('cycle')} />
        <SvcBtn label="off" danger disabled={locked || !on} onClick={() => onPower('off')} />
        <button
          onClick={onConsole}
          className="border-accent/30 text-accent hover:bg-accent/10 ml-auto rounded border px-2 py-1"
        >
          console
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
        {/* rediscover + exec need the node reachable over SSH; reset is a DB/redis teardown so it runs
            regardless of power, but stays locked while the node is still coming up. */}
        {/* all three resolve the node through the fleet config, so orphan VMs (not in config) 404 */}
        <SvcBtn label="rediscover" disabled={locked || !on || !machine.configured} onClick={onDiscover} />
        <SvcBtn label="exec" disabled={locked || !on || !machine.configured} onClick={onExec} />
        <SvcBtn label="reset" danger disabled={locked || !machine.configured} onClick={onReset} />
        {deviceId && (
          <Link
            to="/datastore"
            search={(prev) => deviceQueuesSearch(prev, deviceId)}
            title="Open the queue inspector filtered to this device's jobs"
            className="border-accent/30 text-accent hover:bg-accent/10 ml-auto rounded border px-2 py-1"
          >
            queues
          </Link>
        )}
        {deviceId && (
          <Link
            to="/hub"
            search={(prev) => deviceTokensSearch(prev, deviceId)}
            title="Open the hub view filtered to this device's tokens and phone-home recency"
            className="border-accent/30 text-accent hover:bg-accent/10 rounded border px-2 py-1"
          >
            tokens
          </Link>
        )}
      </div>
    </div>
  );
}

/** Small modal to run one SSH command on a fleet node and show the result. exit_code carries lab
 *  sentinels: 255 = ssh transport failure, 124 = lab-side timeout, otherwise the remote exit status. */
function ExecModal({
  node,
  onClose,
  exec,
}: {
  node: string;
  onClose: () => void;
  exec: ReturnType<typeof tsr.execMachine.useMutation>;
}) {
  const toast = useToast();
  const [command, setCommand] = useState('');
  const [user, setUser] = useState('');
  const [timeoutS, setTimeoutS] = useState('');

  const run = () => {
    // guard the Enter path too (the button is disabled while pending) so a second keypress can't
    // fire a concurrent SSH command whose result races the first for the display.
    if (exec.isPending) return;
    const cmd = command.trim();
    if (!cmd) return;
    const parsed = timeoutS.trim() ? Number.parseInt(timeoutS, 10) : undefined;
    exec.mutate(
      {
        body: {
          name: node,
          command: cmd,
          user: user.trim() || undefined,
          timeout_s: parsed !== undefined && !Number.isNaN(parsed) ? parsed : undefined,
        },
      },
      { onError: (e) => toast.error(`exec — ${errorMessage(e) ?? 'request failed'}`) },
    );
  };

  const data = exec.data;
  const result = data?.status === 200 ? data.body : null;
  const reqError = data && data.status !== 200 ? (bodyError(data.body) ?? `exec failed (${data.status})`) : null;
  const inputCls =
    'border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded-md border px-2 py-1.5 text-sm outline-none';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="border-border-dim bg-bg-secondary max-h-full w-[560px] space-y-3 overflow-auto rounded-lg border p-5">
        <div className="flex items-center justify-between">
          <div className="text-text-primary text-sm font-semibold">
            Exec on <span className="font-mono">{node}</span>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-primary text-sm">
            ✕
          </button>
        </div>
        <p className="text-text-dim text-[11px]">
          Runs one SSH command with the operator key and blocks until it finishes. Defaults to the root (brokkr-live)
          user; pass ubuntu/debian to reach a deployed OS.
        </p>
        <input
          autoFocus
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && run()}
          placeholder="command, e.g. nvidia-smi -L"
          className={`${inputCls} font-mono`}
        />
        <div className="flex gap-2">
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="user (root)"
            className={inputCls}
          />
          <input
            value={timeoutS}
            onChange={(e) => setTimeoutS(e.target.value)}
            inputMode="numeric"
            placeholder="timeout s (30)"
            className={inputCls}
          />
        </div>
        {reqError && <div className="text-status-offline text-xs">{reqError}</div>}
        {result && <ExecResultView result={result} />}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-text-muted hover:bg-hover-bg rounded-md px-3 py-1.5 text-sm">
            Close
          </button>
          <button
            onClick={run}
            disabled={exec.isPending || !command.trim()}
            className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {exec.isPending ? 'running…' : 'run'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExecResultView({ result }: { result: ExecResult }) {
  const code = result.exit_code;
  const note =
    code === 0 ? 'ok' : code === 255 ? 'ssh transport failure' : code === 124 ? 'lab-side timeout' : 'nonzero exit';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 font-mono text-xs">
        <span className={code === 0 ? 'text-status-online' : 'text-status-offline'}>
          exit {code} · {note}
        </span>
        <span className="text-text-dim">{result.duration_ms} ms</span>
      </div>
      <ExecStream label="stdout" text={result.stdout} />
      <ExecStream label="stderr" text={result.stderr} />
    </div>
  );
}

function ExecStream({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-text-dim mb-0.5 text-[10px] tracking-wide uppercase">{label}</div>
      <pre className="border-border-dim bg-bg-primary text-text-primary max-h-[30vh] overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
        {text || '—'}
      </pre>
    </div>
  );
}

export const Route = createFileRoute('/fleet')({ component: FleetPage });
