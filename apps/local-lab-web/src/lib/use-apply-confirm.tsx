import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import { GateModal, type GateView } from '@/components/console';
import { tsr } from '@/lib/api';

/** `allowDataLoss` flows to the backend so a disk-recreate only runs on explicit consent — the
 *  apply recomputes the plan at run time and aborts if it turned destructive without it. */
export type ApplyConfirm = { proceed: boolean; allowDataLoss: boolean };

// consent wording is the data-loss contract — the exact risk the operator must read before proceeding.
const NO_PLAN_MSG = "Couldn't verify the apply plan — it may wipe a node disk or trigger a full rebuild. Continue?";

type ApplyConfirmApi = { prompt: (message: string) => Promise<boolean> };

const ApplyConfirmContext = createContext<ApplyConfirmApi | null>(null);

export function ApplyConfirmProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    setMessage(null);
    resolveRef.current?.(ok);
    resolveRef.current = null;
  }, []);

  const prompt = useCallback(
    (msg: string) =>
      new Promise<boolean>((resolve) => {
        // strictly one confirm at a time (as window.confirm was): a newer request supersedes any
        // pending one, resolving the old promise false so its caller aborts safely and never hangs.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setMessage(msg);
      }),
    [],
  );

  const api = useRef<ApplyConfirmApi>({ prompt }).current;

  const gate: GateView | null =
    message !== null
      ? {
          label: 'Apply fleet changes',
          destructive: true,
          description: message,
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

/** Fetches the apply plan and, when the change is destructive, prompts via the root gate modal. */
export function useApplyConfirm() {
  const ctx = useContext(ApplyConfirmContext);
  if (!ctx) throw new Error('useApplyConfirm must be used within an ApplyConfirmProvider');
  const { prompt } = ctx;
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
      const msg = plan.fallbackFullRebuild
        ? `This change requires a full rebuild (${plan.reason ?? 'identity shift'}). Continue?`
        : 'This will wipe a node disk. Continue?';
      const ok = await prompt(msg);
      return { proceed: ok, allowDataLoss: ok };
    }
    return { proceed: true, allowDataLoss: false };
  };

  return { confirmApply };
}
