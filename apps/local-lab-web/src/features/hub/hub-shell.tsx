import type { ReactNode } from 'react';

import { ErrorBanner } from '@/features/datastore/shared/error-banner';

/** A short list is only a measurement when nothing was skipped and nothing failed, so the count of
 *  rows this build could not parse is stated rather than quietly dropped. */
export function ListState({
  error,
  readError,
  skipped,
  isPending,
  children,
}: {
  error: string | null;
  readError: string | null | undefined;
  skipped: number | undefined;
  isPending: boolean;
  children: ReactNode;
}) {
  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (readError) return <ErrorBanner>unreadable — {readError}</ErrorBanner>;
  if (isPending) return <div className="text-text-dim text-xs">loading…</div>;
  return (
    <div className="space-y-2">
      {skipped !== undefined && skipped > 0 && (
        <div
          className="text-status-warning text-[11px]"
          title="rows this build could not parse; the list is short by that many rather than complete"
        >
          {skipped} row(s) unreadable and omitted
        </div>
      )}
      {children}
    </div>
  );
}

export function HubTable({ columns, children }: { columns: readonly string[]; children: ReactNode }) {
  return (
    <div className="border-border-dim overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr className="bg-bg-secondary text-text-dim sticky top-0 text-left">
            {columns.map((column) => (
              <th key={column} className="border-border-dim border-b px-2 py-1.5 font-normal">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function NoRows({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td className="text-text-dim px-2 py-3" colSpan={span}>
        {children}
      </td>
    </tr>
  );
}
