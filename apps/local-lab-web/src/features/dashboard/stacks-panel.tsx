import { ExternalLink } from 'lucide-react';

import { SectionHeading } from '@/components/console';
import { StatusDot } from '@/components/status/status-card';
import type { RegisteredStack } from '@/contract';

const checkoutName = (checkout: string): string => checkout.split('/').filter(Boolean).pop() ?? checkout;

function StackRow({ stack, isSelf }: { stack: RegisteredStack; isSelf: boolean }) {
  const liveUi = stack.live
    ? { dot: 'bg-status-online', text: 'text-status-online', note: 'live' }
    : { dot: 'bg-text-dim', text: 'text-text-muted', note: 'not live' };
  // both link the UI a human opens, never the API behind it (hubUrl/labUrl are the JSON surfaces)
  const links = [
    { label: 'hub', url: stack.webUrl },
    { label: 'lab', url: stack.labWebUrl },
  ];
  return (
    <div className="flex items-center gap-2 py-1 text-[11px]">
      <StatusDot className={liveUi.dot} />
      <span className="text-text-primary min-w-0 truncate font-medium" title={stack.checkout}>
        {checkoutName(stack.checkout)}
        {isSelf ? ' (this checkout)' : ''}
      </span>
      <span className="text-text-dim shrink-0 font-mono">slot {stack.slot}</span>
      <span className={`shrink-0 ${liveUi.text}`}>{liveUi.note}</span>
      <span className="text-text-dim min-w-0 flex-1 truncate">
        {stack.healthLine ?? `${stack.processes.running}/${stack.processes.total} processes`}
      </span>
      <span className="flex shrink-0 gap-1.5">
        {links.map((l) =>
          l.url ? (
            <a
              key={l.label}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="border-border-dim text-text-muted hover:bg-hover-bg flex items-center gap-1 rounded border px-1.5 py-0.5"
            >
              <ExternalLink className="size-3" />
              {l.label}
            </a>
          ) : (
            <span key={l.label} className="border-border-dim text-text-dim rounded border px-1.5 py-0.5 opacity-50">
              {l.label}
            </span>
          ),
        )}
      </span>
    </div>
  );
}

/** Host-wide stack-slot strip; liveness comes from each stack's own pc.sock, never the registry entry. */
export function StacksPanel({ stacks, selfSlot }: { stacks: RegisteredStack[]; selfSlot: number | null }) {
  // the server always sends a number, so a null slot means the query has not answered — printing
  // "slot 0" there would be a guess, not a fact.
  if (stacks.length === 0 && selfSlot === null) return null;
  const sorted = [...stacks].sort((a, b) => a.slot - b.slot);
  return (
    <section className="border-border-dim rounded-md border px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeading>Stack slots</SectionHeading>
        {sorted.length > 0 && (
          <span className="text-text-dim text-[11px]">
            {sorted.length === 1 ? 'only this slot is claimed on this host' : `${sorted.length} claimed on this host`}
          </span>
        )}
      </div>
      {sorted.length === 0 ? (
        <div className="text-text-dim text-[11px]">slot {selfSlot} · this checkout — not in the host slot registry</div>
      ) : (
        <div className="divide-border-dim divide-y">
          {sorted.map((s) => (
            <StackRow key={s.slot} stack={s} isSelf={s.slot === selfSlot} />
          ))}
        </div>
      )}
    </section>
  );
}
