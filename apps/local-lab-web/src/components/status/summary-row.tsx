import type { ReactNode } from 'react';

import type { HealthUi } from './health-ui';

/** The rail's one-line summary shape, shared so the rows read as a column: the lead slot keeps its
 *  width when empty, so a row with no chevron still lines its dot up with one that has. */
export function SummaryRow({
  lead,
  ui,
  label,
  detail,
  title,
  expanded,
  onClick,
  action,
}: {
  lead?: ReactNode;
  ui: HealthUi;
  label: string;
  detail: string;
  title?: string;
  expanded?: boolean;
  onClick?: () => void;
  action?: ReactNode;
}) {
  const body = (
    <>
      <span className="text-text-dim w-2 shrink-0 text-left">{lead}</span>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ui.dot}`} />
      <span className="text-text-dim shrink-0 tracking-wide uppercase">{label}</span>
      <span className={`truncate ${ui.text}`}>· {detail}</span>
    </>
  );
  const inner = 'flex min-w-0 flex-1 items-center gap-1.5';
  return (
    <div className="flex items-center gap-1.5 text-[10px]" title={title}>
      {onClick ? (
        <button onClick={onClick} aria-expanded={expanded} className={`hover:text-text-muted ${inner}`}>
          {body}
        </button>
      ) : (
        <div className={inner}>{body}</div>
      )}
      {action}
    </div>
  );
}
