import { useState } from 'react';

import type { RepoBranch } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage, thrownBodyError } from '@/lib/errors';

export function useBranchCheckout() {
  const branches = tsr.getStackBranches.useQuery({ queryKey: ['stack-branches'] });
  const putBranches = tsr.putStackBranches.useMutation();

  const [branchEdit, setBranchEdit] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [rebuildRequired, setRebuildRequired] = useState(false);

  const currentBranch = (): RepoBranch | null => (branches.data?.status === 200 ? branches.data.body : null);
  const effective = (): RepoBranch | null => {
    const got = currentBranch();
    const failure = branchError ?? errorMessage(branches.error);
    if (failure) return { branch: got?.branch ?? null, error: failure };
    return got;
  };
  const inputValue = () => {
    if (branchEdit !== null) return branchEdit;
    return currentBranch()?.branch ?? '';
  };
  const setInput = (v: string) => {
    setBranchError(null);
    setBranchEdit(v);
    // deliberately leaves the config form clean: a checkout writes no overlay, and dirty drives the
    // seed-failure save block
  };
  const pending = (): string | undefined => {
    const cur = currentBranch();
    if (branchEdit !== null && branchEdit.trim() && branchEdit.trim() !== cur?.branch) return branchEdit.trim();
    return undefined;
  };
  const checkout = (branch: string, done?: () => void) =>
    putBranches.mutate(
      { body: { branch } },
      {
        onSuccess: (res) => {
          setBranchError(res.body.error);
          if (!res.body.error) {
            setRebuildRequired(res.body.ccRebuildRequired);
            setBranchEdit(null);
          }
          void branches.refetch();
          done?.();
        },
        onError: (err) => {
          setBranchError(thrownBodyError(err) ?? errorMessage(err) ?? 'invalid branch name');
          done?.();
        },
      },
    );

  return { effective, inputValue, setInput, pending, checkout, busy: putBranches.isPending, rebuildRequired };
}
