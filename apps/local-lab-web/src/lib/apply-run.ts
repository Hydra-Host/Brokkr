import { tsr } from '@/lib/api';
import { activeJobsFromBody, responseStatus, thrownBody, thrownBodyError } from '@/lib/errors';
import { useApplyConfirm } from '@/lib/use-apply-confirm';
import { useHostToken } from '@/lib/use-host-token';

export const forceFlipMessage = (n: number): string =>
  `${n} saga job${n === 1 ? '' : 's'} still in flight across the zones. Force the plane flip anyway? This may strand those jobs.`;

export function useApplyPending(onRun: (runId: string) => void, onError: (msg: string) => void) {
  const start = tsr.startStackRun.useMutation();
  // One-shot (no refetchInterval): sudo status is only needed at apply time, and only for the
  // planes-change branch — a background poll would fire for every mount that never uses it.
  const sudo = tsr.getSudoStatus.useQuery({ queryKey: ['sudo'] });
  const cacheSudo = tsr.cacheSudo.useMutation();
  const { confirmApply, prompt } = useApplyConfirm();
  const hostGate = useHostToken('Caching a sudo password');

  // The Apply-planes path must gate on cached sudo like useOps does or the flip fails at cap-ensure;
  // refetch fresh — the sudo timestamp may have expired since mount.
  const ensureSudo = async (): Promise<boolean> => {
    const fresh = await sudo.refetch();
    if (fresh.data?.status === 200 && fresh.data.body.available) return true;
    if (hostGate.blocked) {
      hostGate.ask();
      onError('caching sudo needs the host token; enter it above and retry');
      return false;
    }
    const pw = window.prompt('Applying a plane change needs sudo (bare-metal cap-ensure). Enter your sudo password:');
    if (!pw) {
      onError('sudo is required to apply a fleet plane change');
      return false;
    }
    // the ts-rest client rejects every non-2xx, so a 401 rejection and a 429 throttle both land in
    // the catch — surface the server's own message, which names the cooldown's seconds remaining.
    try {
      await cacheSudo.mutateAsync({
        body: { password: pw },
        extraHeaders: { 'x-lab-token': hostGate.token },
      });
    } catch (err) {
      if (hostGate.noteThrownRefusal(err)) {
        onError('caching sudo needs the host token; enter it above and retry');
        return false;
      }
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
        onSuccess: (r) => onRun(r.body.runId),
        onError: (err: unknown) => {
          if (responseStatus(err) === 409) {
            // only the active-saga 409 carries activeJobs; lane contention must not offer a force
            const activeJobs = activeJobsFromBody(thrownBody(err));
            if (onBlocked && activeJobs > 0) {
              onBlocked(activeJobs);
              return;
            }
            onError(thrownBodyError(err) ?? 'a stack operation is already running');
            return;
          }
          onError(thrownBodyError(err) ?? 'apply failed to start');
        },
      },
    );

  const apply = async (isPlanesChange: boolean) => {
    if (isPlanesChange) {
      if (!(await ensureSudo())) return;
      launchRun({ opId: 'fleet-planes-apply' }, (n) => {
        void prompt(forceFlipMessage(n)).then((ok) => {
          if (ok) launchRun({ opId: 'fleet-planes-apply', force: true });
        });
      });
      return;
    }
    const { proceed, allowDataLoss } = await confirmApply();
    if (!proceed) return;
    launchRun({ opId: 'fleet-apply', allowDataLoss });
  };

  // cacheSudo.isPending covers the async prompt→cache window so the Apply button stays disabled and
  // a double-click can't fire two concurrent flips.
  return {
    apply,
    launchRun,
    isPending: start.isPending || cacheSudo.isPending,
    hostTokenDialog: hostGate.dialog,
  };
}
