import { createFileRoute, Link } from '@tanstack/react-router';
import type { ClientInferRequest, ClientInferResponses } from '@ts-rest/core';
import { useState, type ReactNode } from 'react';

import { BaseOsPicker, type BaseOsAssignment } from '@/components/base-os-picker';
import { CloudInitPicker } from '@/components/cloud-init-picker';
import { RecentRuns, SectionHeading } from '@/components/console';
import { DiskLayoutPicker } from '@/components/disk-layout-picker';
import { IpxePicker } from '@/components/ipxe-picker';
import { LayerPicker } from '@/components/layer-picker';
import { PlanPicker } from '@/components/plan-picker';
import { RescuePicker } from '@/components/rescue-picker';
import { TimelinePanel } from '@/components/timeline-panel';
import type { contract, Run, TestScenario } from '@/contract';
import { tsr } from '@/lib/api';
import { bodyError } from '@/lib/errors';
import { useTestRuns } from '@/lib/use-test-runs';

type StartBody = ClientInferRequest<typeof contract.startTest>['body'];
type PickerKind = NonNullable<TestScenario['picker']>;
type ModalKind = PickerKind | 'confirm';
type ActiveModal = { kind: ModalKind; sc: TestScenario };

type PickerContext = {
  sc: TestScenario;
  allNodes: number[];
  onClose: () => void;
  onLaunch: (bodies: StartBody[]) => void;
};

const PICKERS: Record<PickerKind, (ctx: PickerContext) => ReactNode> = {
  layers: ({ sc, onClose, onLaunch }) => (
    <LayerPicker
      initialNode={0}
      onClose={onClose}
      onRun={(p) =>
        onLaunch([{ scenarioId: sc.id, nodeIndex: p.nodeIndex, base: p.base, customizations: p.customizations }])
      }
    />
  ),
  cloudinit: ({ sc, onClose, onLaunch }) => (
    <CloudInitPicker
      initialNode={0}
      onClose={onClose}
      onRun={(p) => onLaunch([{ scenarioId: sc.id, nodeIndex: p.nodeIndex, cloudInit: p.cloudInit }])}
    />
  ),
  rescue: ({ sc, onClose, onLaunch }) => (
    <RescuePicker
      initialNode={0}
      onClose={onClose}
      onRun={(p) => onLaunch([{ scenarioId: sc.id, nodeIndex: p.nodeIndex, rescueOs: p.rescueOs }])}
    />
  ),
  baseos: ({ sc, allNodes, onClose, onLaunch }) => (
    <BaseOsPicker
      initialNodes={allNodes}
      onClose={onClose}
      onRun={(p) => onLaunch(baseOsStartBodies(sc, p.assignments))}
    />
  ),
  ipxe: ({ sc, onClose, onLaunch }) => (
    <IpxePicker
      initialNode={0}
      onClose={onClose}
      onRun={(p) => onLaunch([{ scenarioId: sc.id, nodeIndex: p.nodeIndex, ipxeUrl: p.ipxeUrl }])}
    />
  ),
  disklayout: ({ sc, onClose, onLaunch }) => (
    <DiskLayoutPicker
      initialNode={0}
      onClose={onClose}
      onRun={(p) => onLaunch([{ scenarioId: sc.id, nodeIndex: p.nodeIndex, diskLayouts: p.diskLayouts }])}
    />
  ),
  plan: ({ sc, onClose, onLaunch }) => (
    <PlanPicker
      initialNode={0}
      onClose={onClose}
      onRun={(p) => onLaunch([{ scenarioId: sc.id, nodeIndex: p.nodeIndex, plan: p.plan }])}
    />
  ),
};

// a picker the registry cannot render falls through to destructive/launch as it did pre-registry, so
// version skew on the contract enum cannot reach PICKERS[kind] and throw inside render.
export function modalKindFor(sc: TestScenario): ModalKind | null {
  if (sc.picker && sc.picker in PICKERS) return sc.picker;
  return sc.destructive ? 'confirm' : null;
}

export function scenarioStartBodies(sc: TestScenario, selectedNodes: number[], selectedSteps: string[]): StartBody[] {
  const targets: (number | null)[] = sc.pinNode && selectedNodes.length > 0 ? selectedNodes : [null];
  const steps = sc.steps && selectedSteps.length > 0 ? selectedSteps : undefined;
  return targets.map((nodeIndex) => ({ scenarioId: sc.id, nodeIndex, steps }));
}

export function baseOsStartBodies(sc: TestScenario, assignments: BaseOsAssignment[]): StartBody[] {
  return assignments.map((a) => ({ scenarioId: sc.id, nodeIndex: a.nodeIndex, baseOses: a.baseOses }));
}

function TestingPage() {
  const runs = useTestRuns();
  const runList = runs.data?.status === 200 ? runs.data.body : [];

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col">
      <div className="min-h-0 flex-1">
        <RunTab runList={runList} runs={runs} />
      </div>
    </div>
  );
}

function RunTab({ runList, runs }: { runList: Run[]; runs: ReturnType<typeof tsr.listRuns.useQuery> }) {
  const scenarios = tsr.listTests.useQuery({ queryKey: ['tests'] });
  const fleet = tsr.getFleetConfig.useQuery({ queryKey: ['fleet-config'] });
  const start = tsr.startTest.useMutation();
  const cancel = tsr.cancelRun.useMutation();

  const [selected, setSelected] = useState<number[]>([]);
  const [selectedSteps, setSelectedSteps] = useState<string[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);

  const confirm = activeModal?.kind === 'confirm' ? activeModal.sc : null;

  const scenarioList = scenarios.data?.status === 200 ? scenarios.data.body : [];
  const fleetBody = fleet.data?.status === 200 ? fleet.data.body : null;
  const NODES = (fleetBody?.mode === 'baremetal' ? fleetBody.baremetal.nodes : (fleetBody?.nodes ?? [])).map(
    (n, index) => ({ index, label: n.name }),
  );
  const ALL = NODES.map((n) => n.index);
  const nodeLabel = (i: number) => NODES[i]?.label ?? `node ${i}`;
  const busyNodes = new Set(
    runList.filter((r) => r.status === 'running' && r.nodeIndex != null).map((r) => r.nodeIndex!),
  );

  const toggleNode = (i: number) => setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort()));
  const freeNodes = ALL.filter((i) => !busyNodes.has(i));
  const isAll =
    freeNodes.length > 0 && selected.length === freeNodes.length && freeNodes.every((i) => selected.includes(i));
  const toggleAll = () => setSelected(isAll ? [] : [...freeNodes]);
  const targetLabel = selected.length === 0 ? 'auto' : isAll ? 'all' : `${selected.length} nodes`;

  const handleStartResult = (res: ClientInferResponses<typeof contract.startTest>, setActive?: boolean) => {
    if (res.status === 200) {
      if (setActive) setActiveRun(res.body.runId);
      void runs.refetch();
      return;
    }
    const msg = bodyError(res.body) ?? `start failed (${res.status})`;
    setStartError((prev) => (prev ? `${prev}\n${msg}` : msg));
  };

  const startRuns = (bodies: StartBody[]) => {
    setStartError(null);
    bodies.forEach((body, k) => {
      start.mutate({ body }, { onSuccess: (res) => handleStartResult(res, k === 0) });
    });
  };

  const launch = (sc: TestScenario) => startRuns(scenarioStartBodies(sc, selected, selectedSteps));

  const closeModal = () => setActiveModal(null);

  const onRun = (sc: TestScenario) => {
    const kind = modalKindFor(sc);
    if (kind === 'confirm') {
      setSelected([]);
      setSelectedSteps(sc.steps?.map((s) => s.value) ?? []);
    }
    setActiveModal(kind ? { kind, sc } : null);
    if (!kind) launch(sc);
  };

  return (
    <div className="grid h-full grid-cols-1 gap-6 lg:grid-cols-[340px_1fr]">
      <div className="space-y-4 pr-1 lg:min-h-0 lg:overflow-auto">
        <SectionHeading>Scenarios</SectionHeading>
        <p className="text-text-dim text-[11px]">
          Runs the e2e test suite against the live stack + fleet. Lifecycle scenarios are destructive.
        </p>

        <div className="space-y-2">
          {scenarioList.map((sc) => (
            <ScenarioButton
              key={sc.id}
              sc={sc}
              active={activeRun !== null && start.isPending}
              disabled={start.isPending || !!sc.disabled}
              node={sc.pinNode ? `${freeNodes.length} free` : undefined}
              onClick={() => onRun(sc)}
            />
          ))}
          {scenarioList.length === 0 && <div className="text-text-dim text-xs">no scenarios</div>}
        </div>

        {startError && (
          <div className="border-status-offline/30 bg-status-offline/10 text-status-offline rounded-md border px-3 py-2 text-xs whitespace-pre-line">
            {startError}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <SectionHeading>Recent runs</SectionHeading>
          <Link to="/results" className="text-accent/80 hover:text-accent text-[11px]">
            view results
          </Link>
        </div>
        <RecentRuns
          runs={runList}
          onSelect={setActiveRun}
          onCancel={(runId) => cancel.mutate({ params: { runId }, body: {} }, { onSuccess: () => void runs.refetch() })}
          activeId={activeRun}
        />
      </div>

      <div className="relative flex min-h-0 flex-col">
        <TimelinePanel
          runId={activeRun}
          isRunning={runList.some((r) => r.runId === activeRun && r.status === 'running')}
        />

        {confirm && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="border-border-dim bg-bg-secondary w-[440px] space-y-3 rounded-lg border p-5">
              <div className="text-text-primary text-sm font-semibold">Confirm: {confirm.label}</div>
              {confirm.pinNode && (
                <div className="space-y-1.5">
                  <label className="text-text-muted text-[11px] tracking-wide uppercase">
                    Targets — <span className="text-text-muted">{targetLabel}</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={toggleAll}
                      title={`Auto = one run on an auto-picked device · All = ${ALL.length} parallel runs (one per node)`}
                      className={[
                        'rounded-md border px-2 py-1 font-mono text-xs transition',
                        selected.length === 0 || isAll
                          ? 'border-accent/50 bg-accent/10 text-accent'
                          : 'border-border-dim text-text-muted hover:bg-hover-bg',
                      ].join(' ')}
                    >
                      {isAll ? `All ×${ALL.length}` : 'Auto'}
                    </button>
                    {NODES.map((n) => {
                      const busy = busyNodes.has(n.index);
                      return (
                        <button
                          key={n.label}
                          onClick={() => !busy && toggleNode(n.index)}
                          disabled={busy}
                          title={busy ? `${n.label} has a running test` : undefined}
                          className={[
                            'rounded-md border px-2 py-1 font-mono text-xs transition',
                            busy
                              ? 'border-status-warning/30 text-status-warning/50 cursor-not-allowed line-through'
                              : selected.includes(n.index)
                                ? 'border-accent/50 bg-accent/10 text-accent'
                                : 'border-border-dim text-text-muted hover:bg-hover-bg',
                          ].join(' ')}
                        >
                          {n.label}
                          {busy ? ' (busy)' : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {confirm.steps && confirm.steps.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-text-muted text-[11px] tracking-wide uppercase">Steps</label>
                  <div className="flex flex-wrap gap-1.5">
                    {confirm.steps.map((s) => {
                      const on = selectedSteps.includes(s.value);
                      return (
                        <button
                          key={s.value}
                          onClick={() =>
                            setSelectedSteps((prev) =>
                              prev.includes(s.value) ? prev.filter((v) => v !== s.value) : [...prev, s.value],
                            )
                          }
                          className={[
                            'rounded-md border px-2 py-1 font-mono text-xs transition',
                            on
                              ? 'border-accent/50 bg-accent/10 text-accent'
                              : 'border-border-dim text-text-muted hover:bg-hover-bg',
                          ].join(' ')}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="text-status-offline/90 text-xs">
                Destructive: drives a real provision/deprovision saga on{' '}
                <span className="font-mono">
                  {confirm.pinNode
                    ? selected.length
                      ? selected.map((i) => nodeLabel(i)).join(', ')
                      : 'an auto-picked node'
                    : 'the fleet'}
                </span>
                {confirm.pinNode && selected.length > 1 ? ` (${selected.length} parallel runs)` : ''}. This takes
                minutes.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={closeModal}
                  className="text-text-muted hover:bg-hover-bg rounded-md px-3 py-1.5 text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    launch(confirm);
                    closeModal();
                  }}
                  disabled={!!confirm.steps && selectedSteps.length === 0}
                  className="bg-status-offline/20 text-status-offline hover:bg-status-offline/30 rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Run
                </button>
              </div>
            </div>
          </div>
        )}

        {activeModal &&
          activeModal.kind !== 'confirm' &&
          PICKERS[activeModal.kind]({
            sc: activeModal.sc,
            allNodes: ALL,
            onClose: closeModal,
            onLaunch: (bodies) => {
              startRuns(bodies);
              closeModal();
            },
          })}
      </div>
    </div>
  );
}

function ScenarioButton({
  sc,
  active,
  disabled,
  node,
  onClick,
}: {
  sc: TestScenario;
  active: boolean;
  disabled: boolean;
  node?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'w-full rounded-md border px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-40',
        'border-border-dim text-text-primary hover:bg-hover-bg',
        active ? 'ring-accent/50 ring-1' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 font-medium">
        {sc.label}
        {sc.pinNode && node && <span className="text-accent/70 font-mono text-[10px]">{node}</span>}
      </div>
      <div className="text-text-dim mt-0.5 text-[11px] leading-snug">{sc.description}</div>
      {sc.disabled && sc.disabledReason && (
        <div className="text-status-warning/60 mt-1 text-[10px]">{sc.disabledReason}</div>
      )}
    </button>
  );
}

export const Route = createFileRoute('/testing')({ component: TestingPage });
