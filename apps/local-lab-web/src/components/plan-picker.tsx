import { useMemo, useState } from 'react';

import { NodeChips, useFleetNodes } from '@/components/ui/node-chips';
import { PickerModal } from '@/components/ui/picker-modal';
import type { PlanJson, StepSpec } from '@/contract';
import { tsr } from '@/lib/api';

// Custom-plan builder: clone a preset, tweak steps/params, emit assembled plan JSON to the plan-custom
// scenario (SIM_PLAN). Inputs are loosely guarded — the engine's validatePlan fails bad plans loudly.

interface EditStep {
  step: string;
  params: Record<string, string>; // raw input text, parsed on assemble
  always: boolean;
}

/** A preset PlanJson -> editable rows (object params shown as JSON text). */
function toEditSteps(plan: PlanJson): EditStep[] {
  return plan.steps.map((s) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.params ?? {})) {
      params[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return { step: s.step, params, always: s.always === true };
  });
}

export function PlanPicker({
  initialNode,
  onClose,
  onRun,
}: {
  initialNode: number;
  onClose: () => void;
  onRun: (p: { nodeIndex: number; plan: string }) => void;
}) {
  const catalog = tsr.getPlanCatalog.useQuery({ queryKey: ['plan-catalog'] });
  const nodes = useFleetNodes();
  const steps = catalog.data?.status === 200 ? catalog.data.body.steps : [];
  const presets = catalog.data?.status === 200 ? catalog.data.body.presets : [];
  const fullSuite = catalog.data?.status === 200 ? catalog.data.body.fullSuite : null;
  const specById = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);

  const [node, setNode] = useState(initialNode);
  const [name, setName] = useState('custom');
  const [rows, setRows] = useState<EditStep[]>([]);
  const [addStep, setAddStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Which preset/full-suite button was last loaded -- drives the highlight so the
  // active choice is obvious. Manual edits below leave it (it marks the origin).
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const loadPreset = (id: string, plan: PlanJson) => {
    setSelectedPreset(id);
    setName(plan.name);
    setRows(toEditSteps(plan));
    setError(null);
  };
  const move = (i: number, d: -1 | 1) =>
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  /** Drag row `from` to position `to` (used by drag-and-drop; arrows use move()). */
  const reorder = (from: number, to: number) =>
    setRows((r) => {
      if (from === to || from < 0 || to < 0 || from >= r.length || to >= r.length) return r;
      const next = [...r];
      const [moved] = next.splice(from, 1);
      // Removing `from` shifts every later index down by one, so a downward drop
      // must insert at to-1 to land on the highlighted row, not one slot below it.
      next.splice(from < to ? to - 1 : to, 0, moved);
      return next;
    });
  const onDrop = (to: number) => {
    if (dragIndex !== null) reorder(dragIndex, to);
    setDragIndex(null);
    setDropIndex(null);
  };
  const remove = (i: number) => setRows((r) => r.filter((_, k) => k !== i));
  const append = (id: string) => {
    if (!id) return;
    setRows((r) => [...r, { step: id, params: {}, always: id === 'end-rental' }]);
    setAddStep('');
  };
  const setParam = (i: number, key: string, value: string) =>
    setRows((r) => r.map((row, k) => (k === i ? { ...row, params: { ...row.params, [key]: value } } : row)));
  const toggleAlways = (i: number) =>
    setRows((r) => r.map((row, k) => (k === i ? { ...row, always: !row.always } : row)));

  /** Build the plan JSON from the editable rows, parsing json-kind params. */
  const assemble = (): string | null => {
    if (rows.length === 0) {
      setError('plan has no steps');
      return null;
    }
    const out: PlanJson['steps'] = [];
    for (const [i, row] of rows.entries()) {
      const spec = specById.get(row.step);
      const params: Record<string, unknown> = {};
      for (const p of spec?.params ?? []) {
        const raw = (row.params[p.key] ?? '').trim();
        if (!raw) continue;
        if (p.kind === 'json') {
          try {
            params[p.key] = JSON.parse(raw);
          } catch {
            setError(`step ${i + 1} (${row.step}): ${p.label} is not valid JSON`);
            return null;
          }
        } else {
          params[p.key] = raw;
        }
      }
      out.push({
        step: row.step,
        ...(Object.keys(params).length ? { params } : {}),
        ...(row.always ? { always: true } : {}),
      });
    }
    return JSON.stringify({ name: name.trim() || 'custom', steps: out });
  };

  const launch = () => {
    const plan = assemble();
    if (plan) onRun({ nodeIndex: node, plan });
  };

  return (
    <PickerModal
      title="Custom Sequence — assemble steps"
      onClose={onClose}
      width="w-[680px]"
      footerNote={<span className="text-text-dim text-[11px]">Runs the assembled plan on one node, in order.</span>}
      confirmLabel="Run plan"
      onConfirm={launch}
      confirmDisabled={rows.length === 0}
    >
      {/* Node */}
      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Node</label>
        <NodeChips nodes={nodes} isSelected={(i) => node === i} onToggle={setNode} />
      </div>

      {/* Clone a preset */}
      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Start from a preset</label>
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map((p) => (
            <button
              key={p.id}
              onClick={() => loadPreset(p.id, p.plan)}
              className={`rounded-md border px-2 py-1 text-xs transition ${
                selectedPreset === p.id
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-border-dim text-text-muted hover:bg-hover-bg'
              }`}
            >
              {p.plan.name}
            </button>
          ))}
          {fullSuite && (
            <button
              onClick={() => loadPreset('__full_suite__', fullSuite)}
              title="Every non-HA scenario on one node, in one run (long). Edit before running if needed."
              className={`rounded-md border px-2 py-1 text-xs transition ${
                selectedPreset === '__full_suite__'
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-border-dim text-text-muted hover:bg-hover-bg'
              }`}
            >
              Full suite
            </button>
          )}
          {presets.length === 0 && <span className="text-text-dim text-[11px]">loading…</span>}
        </div>
      </div>

      {/* Plan name */}
      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Plan name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border-border-dim bg-bg-primary text-text-primary w-full rounded-md border px-2 py-1 text-xs"
        />
      </div>

      {/* Steps */}
      <div className="space-y-2">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Steps ({rows.length})</label>
        {rows.map((row, i) => {
          const spec = specById.get(row.step);
          return (
            <div
              key={i}
              onDragOver={(e) => {
                e.preventDefault();
                if (dropIndex !== i) setDropIndex(i);
              }}
              onDrop={() => onDrop(i)}
              className={[
                'bg-bg-primary space-y-2 rounded-md border p-2.5 transition',
                dragIndex === i ? 'opacity-40' : '',
                dropIndex === i && dragIndex !== null && dragIndex !== i ? 'border-accent/60' : 'border-border-dim',
              ].join(' ')}
            >
              <div
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                className="flex cursor-grab items-center justify-between active:cursor-grabbing"
              >
                <span className="text-text-primary text-sm">
                  <span className="text-text-dim mr-1.5 cursor-grab select-none" title="drag to reorder">
                    ⠿
                  </span>
                  <span className="text-text-dim mr-1.5 font-mono text-[10px]">{i + 1}</span>
                  {spec?.label ?? row.step}
                  <span className="text-text-dim ml-1.5 font-mono text-[10px]">{row.step}</span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="text-text-dim hover:text-text-primary px-1 disabled:opacity-20"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === rows.length - 1}
                    className="text-text-dim hover:text-text-primary px-1 disabled:opacity-20"
                  >
                    ↓
                  </button>
                  <button onClick={() => remove(i)} className="text-status-offline/70 hover:text-status-offline px-1">
                    ✕
                  </button>
                </div>
              </div>

              {(spec?.params ?? []).map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <label className="text-text-muted w-44 shrink-0 text-[11px]">{p.label}</label>
                  <input
                    value={row.params[p.key] ?? ''}
                    onChange={(e) => setParam(i, p.key, e.target.value)}
                    placeholder={p.optional ? 'optional' : 'required'}
                    className="border-border-dim bg-bg-primary text-text-primary w-full rounded border px-2 py-1 font-mono text-[11px]"
                  />
                </div>
              ))}

              <label className="text-text-muted flex items-center gap-1.5 text-[11px]">
                <input type="checkbox" checked={row.always} onChange={() => toggleAlways(i)} />
                always run (cleanup — runs even if an earlier step fails)
              </label>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="border-border-dim text-text-dim rounded-md border border-dashed px-3 py-4 text-center text-[11px]">
            Clone a preset above, or add steps below.
          </div>
        )}
      </div>

      {/* Add step */}
      <div className="flex items-center gap-2">
        <select
          value={addStep}
          onChange={(e) => append(e.target.value)}
          className="border-border-dim bg-bg-primary text-text-muted rounded-md border px-2 py-1 text-xs"
        >
          <option value="">+ add step…</option>
          {steps.map((s: StepSpec) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="border-status-offline/30 bg-status-offline/10 text-status-offline rounded-md border px-3 py-2 text-xs">
          {error}
        </div>
      )}
    </PickerModal>
  );
}
