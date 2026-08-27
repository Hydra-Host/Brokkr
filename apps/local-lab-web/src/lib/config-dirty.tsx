import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ApplyDomain } from '@/features/config/apply-model';

interface DirtyReport {
  dirtyDomain: ApplyDomain | null;
  report: (domain: ApplyDomain, dirty: boolean) => void;
}

const Ctx = createContext<DirtyReport>({ dirtyDomain: null, report: () => {} });

/** The apply panel sits in the layout and each form sits in a page below it, so the page has to hand
 *  its dirtiness up. Without it the panel would offer an apply over edits the operator never saved. */
export function ConfigDirtyProvider({ children }: { children: ReactNode }) {
  const [dirtyDomain, setDirtyDomain] = useState<ApplyDomain | null>(null);
  const report = useCallback(
    (domain: ApplyDomain, dirty: boolean) => setDirtyDomain((cur) => (dirty ? domain : cur === domain ? null : cur)),
    [],
  );
  const value = useMemo(() => ({ dirtyDomain, report }), [dirtyDomain, report]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useConfigDirty = (): ApplyDomain | null => useContext(Ctx).dirtyDomain;

/** Clears on unmount as well as on a clean save: separate routes unmount, so a page that navigates
 *  away mid-edit must not leave the panel blocked on a form nobody can see. */
export function useReportDirty(domain: ApplyDomain, dirty: boolean): void {
  const { report } = useContext(Ctx);
  useEffect(() => {
    report(domain, dirty);
    return () => report(domain, false);
  }, [domain, dirty, report]);
}
