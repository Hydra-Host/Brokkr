import { RESTART_STALE_AFTER_MS, type RestartState, type RestartStatus } from '@repo/local-lab-contract';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { tsr } from '@/lib/api';

export const RESTART_POLL_INTERVAL_MS = 3000;
export const RECREATE_FLAG_KEY = 'brokkr.lab.recreating';
// the only ops whose detached child outlives this API; every other op keeps it up.
export const RECREATE_OP_IDS: readonly string[] = ['reinit', 'reset', 'purge'];

const StampSchema = z.object({ opId: z.string(), at: z.number() });
export type RecreateStamp = z.infer<typeof StampSchema>;

export function markRecreating(opId: string): void {
  try {
    sessionStorage.setItem(RECREATE_FLAG_KEY, JSON.stringify({ opId, at: Date.now() }));
  } catch (error) {
    console.debug('recreating-stamp save failed', error);
  }
}

export function peekRecreating(): RecreateStamp | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(RECREATE_FLAG_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = StampSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearRecreating(): void {
  try {
    sessionStorage.removeItem(RECREATE_FLAG_KEY);
  } catch (error) {
    console.debug('recreating-stamp clear failed', error);
  }
}

/** `idle` is the one status that renders nothing, so every other one IS a banner variant. Deriving a
 *  second vocabulary from the discriminant is what let the old boolean shape drop a failure. */
export type RecreateVariant = Exclude<RestartStatus, 'idle'>;

/** The recreation variants plus the bare outage: the api is down and nothing explains why. */
export type BannerVariant = RecreateVariant | 'unreachable';

export type RestartBanner = {
  variant: BannerVariant;
  reason?: string;
  logPath?: string;
  opId?: string;
};

export type RestartBannerInput = {
  // whatever the last poll to answer handed back. On a failed poll ts-rest keeps returning the stale
  // last-good 200, so it is last-known evidence, never current truth — `isError` decides which.
  state: RestartState | null;
  isError: boolean;
  stamp: RecreateStamp | null;
  now: number;
};

export const isInFlight = (status: RestartStatus): boolean => status === 'pending' || status === 'stale';

export type ConnectionState = 'online' | 'offline' | 'connecting';

export const connectionState = (isError: boolean, hasBody: boolean): ConnectionState =>
  isError ? 'offline' : hasBody ? 'online' : 'connecting';

export function restartBanner({ state, isError, stamp, now }: RestartBannerInput): RestartBanner | null {
  if (isError) return heldThroughOutage(state, stamp, now);
  if (state === null) return null;
  const { reason, logPath, opId } = state;
  switch (state.status) {
    case 'idle':
      return null;
    // everything else renders: keying the variant off the discriminant means a status added later
    // breaks the banner's own copy maps at compile time instead of quietly vanishing from the UI.
    default:
      return { variant: state.status, reason, logPath, opId };
  }
}

/** The marker is unreadable while the API is down, so the launch stamp or the last answer stands in —
 *  staleness bound included, since the server can't apply it down. With neither, the bare outage is all there is. */
function heldThroughOutage(state: RestartState | null, stamp: RecreateStamp | null, now: number): RestartBanner {
  // a stamp means the launch POST was answered, so the marker written for it describes this
  // recreation and outranks anything the last poll saw.
  if (stamp !== null) {
    const live = state !== null && isInFlight(state.status) ? state : null;
    return {
      variant: now - stamp.at > RESTART_STALE_AFTER_MS ? 'stale' : 'pending',
      reason: live?.reason,
      logPath: live?.logPath,
      opId: live?.opId ?? stamp.opId,
    };
  }
  if (state === null || state.status === 'idle') return { variant: 'unreachable' };
  const overBound = state.startedAt !== undefined && now - state.startedAt > RESTART_STALE_AFTER_MS;
  const { reason, logPath, opId } = state;
  if (state.status === 'failed') return { variant: 'failed', reason, logPath, opId };
  return { variant: state.status === 'stale' || overBound ? 'stale' : 'pending', reason, logPath, opId };
}

export function useApiHealth() {
  const q = tsr.getRestartState.useQuery({
    queryKey: ['restart-state'],
    refetchInterval: RESTART_POLL_INTERVAL_MS,
    retry: false,
  });
  const isError = q.isError;
  const state = q.data?.status === 200 ? q.data.body : null;
  const [stamp, setStamp] = useState<RecreateStamp | null>(() => peekRecreating());

  // the stamp lands in sessionStorage outside React just before the op kills the API, so it must load on
  // the failing poll too; only the clear is skipped while erroring — the server can't authorise it then.
  useEffect(() => {
    if (!isError && state !== null && !isInFlight(state.status)) clearRecreating();
    setStamp(peekRecreating());
  }, [isError, state]);

  return {
    banner: restartBanner({ state, isError, stamp, now: Date.now() }),
    link: connectionState(isError, state !== null),
  };
}

export type ApiHealthView = ReturnType<typeof useApiHealth>;
