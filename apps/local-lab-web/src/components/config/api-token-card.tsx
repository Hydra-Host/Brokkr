import { useState } from 'react';

import { hostToken, labApiToken, labTokenIsStackProvided, setHostToken, setLabApiToken } from '@/lib/lab-token';
import { useToast } from '@/lib/toast';

function TokenRow({
  label,
  value,
  placeholder,
  title,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  title: string;
  onSave: (token: string) => string;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(value);
  // the parent holds no state, so the `value` prop never refreshes after a save — track what landed
  const [saved, setSaved] = useState(value);
  const dirty = draft.trim() !== saved;

  const save = () => {
    if (!dirty) return;
    const persisted = onSave(draft);
    setDraft(persisted);
    setSaved(persisted);
    if (persisted !== draft.trim()) {
      toast.error(`Could not save ${label} (browser storage unavailable)`);
      return;
    }
    toast.ok(persisted ? `${label} saved` : `${label} cleared`);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-text-muted w-20 text-[11px]">{label}</span>
      <input
        type="password"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder={placeholder}
        title={title}
        className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-72 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
      />
      <button
        onClick={save}
        disabled={!dirty}
        className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-[11px] disabled:opacity-40"
      >
        Save
      </button>
    </div>
  );
}

export function ApiTokenCard() {
  const stackProvided = labTokenIsStackProvided();

  return (
    <div className="border-border-dim bg-bg-secondary space-y-2 rounded-md border px-3 py-2">
      {stackProvided ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-text-muted w-20 text-[11px]">API token</span>
          <span className="text-text-dim text-[11px]">
            served by this stack and sent automatically — a token stored here is ignored
          </span>
        </div>
      ) : (
        <TokenRow
          label="API token"
          value={labApiToken()}
          placeholder="LAB_API_TOKEN (only for off-loopback access)"
          title="Sent as x-lab-token on API calls and ?token= on log stream URLs (so it appears in SSE request logs — treat as rotatable). Required when the lab API is exposed off-loopback."
          onSave={(token) => {
            setLabApiToken(token);
            return labApiToken();
          }}
        />
      )}

      <TokenRow
        label="Host token"
        value={hostToken()}
        placeholder="LAB_HOST_TOKEN (SQL console and consoles)"
        title="Sent only by the surfaces that run as the stack owner: the SQL console and the interactive consoles. The API token above cannot reach them, whoever issued it — these routes require the host-exec capability."
        onSave={(token) => {
          setHostToken(token);
          return hostToken();
        }}
      />

      <div className="text-text-dim text-[11px]">
        The API token covers ordinary reads and operations. The host token is separate because the SQL console and the
        consoles execute on the host itself.
      </div>
    </div>
  );
}
