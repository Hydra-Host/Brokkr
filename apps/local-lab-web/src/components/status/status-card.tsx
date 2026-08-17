import type { ReactNode } from 'react';

import type { HealthUi } from './health-ui';

export function StatusDot({ className }: { className: string }) {
  return <span className={`h-2 w-2 rounded-full ${className}`} />;
}

export function StatusCard({
  title,
  ui,
  detail,
  failed,
  actions,
  children,
}: {
  title: string;
  ui: HealthUi;
  detail?: string;
  failed?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-border-dim rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <StatusDot className={ui.dot} />
          <span className="text-text-primary font-medium">{title}</span>
        </span>
        <span className={`text-[11px] ${ui.text}`}>{ui.note}</span>
      </div>
      {detail && (
        <div
          className={
            failed ? 'text-status-offline/90 mt-1 text-[11px] break-words' : 'text-text-dim mt-1 truncate text-[11px]'
          }
          title={detail}
        >
          {detail}
        </div>
      )}
      {children}
      {actions && <div className="mt-2 flex gap-2">{actions}</div>}
    </div>
  );
}
