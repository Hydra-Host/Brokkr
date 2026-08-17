import { tsr } from '@/lib/api';
import { thrownBodyError } from '@/lib/errors';
import { useApplyConfirm } from '@/lib/use-apply-confirm';

function activeJobsFromBody(body: unknown): number {
  if (body !== null && typeof body === 'object' && 'activeJobs' in body && typeof body.activeJobs === 'number') {
    return body.activeJobs;
  }
  return 0;
}

export function useApplyPending(onRun: (runId: string) => void, onError: (msg: string) => void) {
  const start = tsr.startStackRun.useMutation();
  // One-shot (no refetchInterval): sudo status is only needed at apply time, and only for the
  // mode-change branch — a background poll would fire for every VM-mode mount that never uses it.
  const sudo = tsr.getSudoStatus.useQuery({ queryKey: ['sudo'] });
  const cacheSudo = tsr.cacheSudo.useMutation();
  const { confirmApply } = useApplyConfirm();

  // The Apply-mode path must gate on cached sudo like useOps does or the flip fails at cap-ensure;
  // refetch fresh — the sudo timestamp may have expired since mount.
  const ensureSudo = async (): Promise<boolean> => {
    const fresh = await sudo.refetch();
    if (fresh.data?.status === 200 && fresh.data.body.available) return true;
    const pw = window.prompt('Apply mode needs sudo (bare-metal cap-ensure). Enter your sudo password:');
    if (!pw) {
      onError('sudo is required to apply a fleet-mode change');
      return false;
    }
    // the ts-rest client rejects every non-2xx, so a 401 rejection and a 429 throttle both land in
    // the catch — surface the server's own message, which names the cooldown's seconds remaining.
    try {
      const res = await cacheSudo.mutateAsync({ body: { password: pw } });
      if (res.status !== 200) {
        onError('sudo password rejected');
        return false;
      }
    } catch (err) {
      onError(thrownBodyError(err) ?? 'sudo password rejected');
      return false;
    }
    return true;
  };

  const launchRun = (
    body: { opId: string; allowDataLoss?: boolean; force?: boolean },
    onBlocked?: (n: number) => void,
  ) =>
    start.mutate(
      { body },
      {
        onSuccess: (r) => {
          if (r.status === 200) {
            onRun(r.body.runId);
            return;
          }
          if (r.status === 409) {
            // Only the active-saga 409 is force-overridable — a lane-contention 409 (no activeJobs)
            // must surface as an error, not a misleading "force the flip" prompt.
            const activeJobs = activeJobsFromBody(r.body);
            if (onBlocked && activeJobs > 0) {
              onBlocked(activeJobs);
              return;
            }
            onError(thrownBodyError(r) ?? 'a stack operation is already running');
            return;
          }
          onError(thrownBodyError(r) ?? 'apply failed to start');
        },
        onError: (err: unknown) => onError(thrownBodyError(err) ?? 'apply failed to start'),
      },
    );

  const apply = async (isModeChange: boolean) => {
    if (isModeChange) {
      if (!(await ensureSudo())) return;
      // onBlocked only fires for the active-saga guard (n > 0); lane contention is surfaced as an
      // error by launchRun, so the prompt always speaks to in-flight saga jobs.
      launchRun({ opId: 'fleet-mode-apply' }, (n) => {
        const msg = `${n} saga job${n === 1 ? '' : 's'} still in flight across the zones. Force the mode flip anyway? This may strand those jobs.`;
        if (window.confirm(msg)) launchRun({ opId: 'fleet-mode-apply', force: true });
      });
      return;
    }
    const { proceed, allowDataLoss } = await confirmApply();
    if (!proceed) return;
    launchRun({ opId: 'fleet-apply', allowDataLoss });
  };

  // cacheSudo.isPending covers the async prompt→cache window so the Apply button stays disabled and
  // a double-click can't fire two concurrent flips.
  return { apply, launchRun, isPending: start.isPending || cacheSudo.isPending };
}
