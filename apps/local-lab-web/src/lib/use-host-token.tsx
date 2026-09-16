import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { isCapabilityRefusal } from '@/contract';
import { bodyError } from '@/lib/errors';
import { hostExecToken, hostTokenNeeded, setHostToken } from '@/lib/lab-token';

/** The lab renders every refusal as the contract's `{ error }` body; any other 403 names an authority
 *  a second token cannot buy, so re-prompting there would just loop. */
export function isHostExecRefusal(status: number, body: unknown): boolean {
  return status === 403 && isCapabilityRefusal(bodyError(body) ?? '', 'host-exec');
}

/** The ts-rest client rejects every non-2xx, so on a mutateAsync/onError path the refusal arrives as
 *  the thrown response rather than a returned one. */
export function isThrownHostExecRefusal(thrown: unknown): boolean {
  if (typeof thrown !== 'object' || thrown === null) return false;
  if (!('status' in thrown) || typeof thrown.status !== 'number') return false;
  return isHostExecRefusal(thrown.status, 'body' in thrown ? thrown.body : undefined);
}

export interface HostTokenGate {
  /** '' when the address is expected to grant the capability, so nothing needs typing. */
  token: string;
  /** The surface must not call yet: a token is provably required and none has been typed. */
  blocked: boolean;
  ask: () => void;
  /** True when the response was a capability refusal, having re-opened the prompt. */
  noteRefusal: (status: number, body: unknown) => boolean;
  /** The same, for a refusal that arrived as a rejection rather than a returned response. */
  noteThrownRefusal: (thrown: unknown) => boolean;
  dialog: ReactNode;
}

function read(): { token: string; blocked: boolean } {
  return { token: hostExecToken(), blocked: hostTokenNeeded() };
}

// a page can mount several gates (fleet holds its own plus the one inside useOps), so a token typed
// into any of them has to re-read the rest or the others stay blocked against a token that exists
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

/** Shared by the three root-equivalent surfaces (SQL console, both terminals): they are the only
 *  callers whose capability the injected token cannot reach. */
export function useHostToken(surface: string): HostTokenGate {
  const [state, setState] = useState(read);

  useEffect(() => {
    // publish() only fires from a successful save, so every open prompt is answered by that token
    const listener = () => {
      setState(read());
      setAsking(false);
    };
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  const [asking, setAsking] = useState(hostTokenNeeded);
  const [draft, setDraft] = useState('');

  const ask = useCallback(() => setAsking(true), []);

  const noteRefusal = useCallback((status: number, body: unknown) => {
    if (!isHostExecRefusal(status, body)) return false;
    setAsking(true);
    return true;
  }, []);

  const noteThrownRefusal = useCallback((thrown: unknown) => {
    if (!isThrownHostExecRefusal(thrown)) return false;
    setAsking(true);
    return true;
  }, []);

  const save = () => {
    // Enter reaches here past the button's disabled state, and an empty save would clear the token
    if (draft.trim() === '') return;
    setHostToken(draft);
    setDraft('');
    publish();
    setAsking(false);
  };

  const dialog = asking ? (
    <div className="border-border-dim bg-bg-secondary space-y-2 rounded-md border px-3 py-2">
      <div className="text-text-muted text-[11px]">
        {surface} runs as the stack owner and needs the host token (LAB_HOST_TOKEN) — the token this page was served
        with does not reach it.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          aria-label="host token"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="LAB_HOST_TOKEN"
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-72 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
        />
        <button
          onClick={save}
          disabled={draft.trim() === ''}
          className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-[11px] disabled:opacity-40"
        >
          Use token
        </button>
        <button onClick={() => setAsking(false)} className="text-text-dim px-2 py-1 text-[11px] hover:underline">
          Dismiss
        </button>
      </div>
    </div>
  ) : null;

  return { token: state.token, blocked: state.blocked, ask, noteRefusal, noteThrownRefusal, dialog };
}
