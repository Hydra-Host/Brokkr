import { RESTART_STALE_AFTER_LABEL } from '@repo/local-lab-contract';

import type { ConnectionState, RestartBanner } from '@/lib/use-restart-state';

const COPY: Record<RestartBanner['variant'], { headline: string; note: string }> = {
  pending: {
    headline: 'Stack is being recreated',
    note: 'Every panel reads empty until it is back — the control-center API drops and reconnects on its own.',
  },
  stale: {
    headline: `Stack recreation has run past ${RESTART_STALE_AFTER_LABEL}`,
    note: 'Nothing more will happen on its own; read the log to see which stage the bring-up wedged on.',
  },
  failed: {
    headline: 'Stack recreation failed while the control center was down',
    note: 'The stack is partly up at best. Read the log, then re-run the op once the cause is fixed.',
  },
  unreachable: {
    headline: 'Control-center API unreachable',
    note: 'Panels keep their last answer; nothing new loads until it reconnects — usually on its own. If it stays down, check the lab process (task status).',
  },
};

const TONE: Record<RestartBanner['variant'], string> = {
  pending: 'border-status-warning/70 bg-status-warning/20 text-status-warning',
  stale: 'border-status-warning/70 bg-status-warning/20 text-status-warning',
  failed: 'border-status-offline/70 bg-status-offline/20 text-status-offline',
  unreachable: 'border-status-offline/70 bg-status-offline/20 text-status-offline',
};

const LINK_DOT: Record<ConnectionState, string> = {
  online: 'bg-status-online animate-pulse',
  connecting: 'bg-status-warning animate-pulse',
  offline: 'bg-status-offline',
};

const LINK_TITLE: Record<ConnectionState, string> = {
  online: 'control-center API reachable',
  connecting: 'contacting the control-center API…',
  offline: 'control-center API unreachable',
};

export function ConnectivityDot({ link }: { link: ConnectionState }) {
  return <span title={LINK_TITLE[link]} className={`h-1.5 w-1.5 rounded-full ${LINK_DOT[link]}`} />;
}

export function RecreatingBanner({ banner }: { banner: RestartBanner | null }) {
  if (!banner) return null;
  const copy = COPY[banner.variant];
  const spinning = banner.variant === 'pending';
  return (
    <div
      className={`mx-4 mt-1 flex shrink-0 flex-col gap-1 rounded-md border px-3 py-2 sm:mx-6 ${TONE[banner.variant]}`}
    >
      <div className="flex items-center gap-2">
        {spinning && <span className="bg-status-warning h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" />}
        <span className="text-sm font-medium">⚠ {copy.headline}</span>
        <span className="text-[11px] opacity-80">{copy.note}</span>
      </div>
      {banner.variant !== 'unreachable' && (
        <details className="text-[11px]">
          <summary className="cursor-pointer">what is happening?</summary>
          <ul className="mt-1 space-y-0.5">
            <li>stage: {banner.reason ?? banner.opId ?? 'a cockpit stack recreation'}</li>
            {banner.logPath && (
              <li>
                log: <span className="font-mono break-all">{banner.logPath}</span>
              </li>
            )}
            {!banner.logPath && <li>log: recorded on the marker the API publishes once it answers again</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
