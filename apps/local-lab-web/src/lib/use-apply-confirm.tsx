import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import { GateModal, type GateView } from '@/components/console';
import type { ApplyPlan } from '@/contract';
import { tsr } from '@/lib/api';
import { fmtSpan } from '@/lib/format';

/** `allowDataLoss` flows to the backend so a disk-recreate only runs on explicit consent — the
 *  apply recomputes the plan at run time and aborts if it turned destructive without it. */
export type ApplyConfirm = { proceed: boolean; allowDataLoss: boolean };

// consent wording is the data-loss contract — the exact risk the operator must read before proceeding.
const NO_PLAN_MSG = "Couldn't verify the apply plan — it may wipe a node disk or trigger a full rebuild. Continue?";

const ACTION_LABEL: Record<ApplyPlan['items'][number]['action'], string> = {
  noop: 'no change',
  'hot-node': 'live update',
  'node-disk': 'recreates disk',
  'add-node': 'adds node',
  'remove-terminal-node': 'removes node',
  'full-rebuild-required': 'forces full rebuild',
};

type ApplyConfirmApi = { prompt: (body: ReactNode) => Promise<boolean> };

const ApplyConfirmContext = createContext<ApplyConfirmApi | null>(null);

export function ApplyConfirmProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<{ body: ReactNode } | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    setView(null);
    resolveRef.current?.(ok);
    resolveRef.current = null;
  }, []);

  const prompt = useCallback(
    (body: ReactNode) =>
      new Promise<boolean>((resolve) => {
        // strictly one confirm at a time (as window.confirm was): a newer request supersedes any
        // pending one, resolving the old promise false so its caller aborts safely and never hangs.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setView({ body });
      }),
    [],
  );

  const api = useRef<ApplyConfirmApi>({ prompt }).current;

  const gate: GateView | null = view
    ? {
        label: 'Apply fleet changes',
        destructive: true,
        description: view.body,
        needsPassword: false,
        password: '',
        setPassword: () => {},
        error: '',
        busy: false,
        confirmLabel: 'Continue',
        confirm: () => settle(true),
        cancel: () => settle(false),
      }
    : null;

  return (
    <ApplyConfirmContext.Provider value={api}>
      {children}
      {gate && <GateModal gate={gate} fixed />}
    </ApplyConfirmContext.Provider>
  );
}

// The gate renders its description inside a <p>, so every element here has to be inline-level.
function ApplyPlanView({ plan }: { plan: ApplyPlan }) {
  const headline = plan.fallbackFullRebuild
    ? `This change requires a full rebuild (${plan.reason ?? 'identity shift'}). Continue?`
    : 'This will wipe a node disk. Continue?';
  return (
    <span className="block space-y-2">
      <span className="block">{headline}</span>
      <span className="block space-y-1">
        {plan.items.map((item) => (
          <span key={item.name} className="flex flex-wrap items-baseline gap-1.5 font-mono text-[11px]">
            <span className="text-text-primary">{item.name}</span>
            <span className={item.dataLoss ? 'text-status-offline' : 'text-text-muted'}>
              {ACTION_LABEL[item.action]}
            </span>
            <span className="text-text-dim">{item.reason}</span>
            {item.fields.length > 0 && <span className="text-text-dim">[{item.fields.join(', ')}]</span>}
            <span className="text-text-dim ml-auto">~{fmtSpan(item.etaSec)}</span>
          </span>
        ))}
      </span>
      <span className="text-text-dim block text-[11px]">total ~{fmtSpan(plan.etaSec)}</span>
    </span>
  );
}

/** The root gate modal's prompt alone, for a caller that never fetches the apply plan. */
export function useApplyPrompt() {
  const ctx = useContext(ApplyConfirmContext);
  if (!ctx) throw new Error('useApplyPrompt must be used within an ApplyConfirmProvider');
  return ctx.prompt;
}

/** Fetches the apply plan and, when the change is destructive, prompts via the root gate modal. */
export function useApplyConfirm() {
  const prompt = useApplyPrompt();
  const planQ = tsr.getFleetApplyPlan.useQuery({ queryKey: ['fleet-apply-plan'], enabled: false });

  const confirmApply = async (): Promise<ApplyConfirm> => {
    const plan = await planQ.refetch().then(
      (res) => (res.data?.status === 200 ? res.data.body : null),
      () => null,
    );
    // couldn't verify the plan (non-200 or network error): fail closed — prompt, and if they
    // proceed, authorize data loss since the recomputed apply may need it.
    if (!plan) {
      const ok = await prompt(NO_PLAN_MSG);
      return { proceed: ok, allowDataLoss: ok };
    }
    if (plan.dataLoss || plan.fallbackFullRebuild) {
      const ok = await prompt(<ApplyPlanView plan={plan} />);
      return { proceed: ok, allowDataLoss: ok };
    }
    return { proceed: true, allowDataLoss: false };
  };

  return { confirmApply, prompt };
}
