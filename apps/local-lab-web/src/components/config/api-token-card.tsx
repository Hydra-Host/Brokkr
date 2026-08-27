import { useState } from 'react';

import { labApiToken, labTokenIsStackProvided, setLabApiToken } from '@/lib/lab-token';
import { useToast } from '@/lib/toast';

export function ApiTokenCard() {
  const toast = useToast();
  const stackProvided = labTokenIsStackProvided();
  const [token, setToken] = useState(stackProvided ? '' : labApiToken());

  const saved = labApiToken();
  const dirty = !stackProvided && token.trim() !== saved;

  const save = () => {
    if (!dirty) return;
    setLabApiToken(token);
    const persisted = labApiToken();
    setToken(persisted);
    if (persisted !== token.trim()) {
      toast.error('Could not save API token (browser storage unavailable)');
      return;
    }
    toast.ok(persisted ? 'API token saved' : 'API token cleared');
  };

  if (stackProvided) {
    return (
      <div className="border-border-dim bg-bg-secondary flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
        <span className="text-text-muted text-[11px]">API token</span>
        <span className="text-text-dim text-[11px]">
          served by this stack (lan.expose) and sent automatically — a token stored here is ignored
        </span>
      </div>
    );
  }

  return (
    <div className="border-border-dim bg-bg-secondary flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
      <span className="text-text-muted text-[11px]">API token</span>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder="LAB_API_TOKEN (only for off-loopback access)"
        title="Sent as x-lab-token on API calls and ?token= on console/log stream URLs (so it appears in WS/SSE request logs — treat as rotatable). Required when the lab API is exposed off-loopback; under lan.expose the stack serves this UI its own token instead and this field is not shown."
        className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-72 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
      />
      <button
        onClick={save}
        disabled={!dirty}
        className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-[11px] disabled:opacity-40"
      >
        Save token
      </button>
    </div>
  );
}
