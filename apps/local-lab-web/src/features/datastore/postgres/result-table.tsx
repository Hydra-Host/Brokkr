import type { PgResult } from '@/contract';
import { Cell } from '@/features/datastore/shared';

export function ResultTable({ result }: { result: PgResult }) {
  if (result.columns.length === 0) return <div className="text-text-dim text-sm">no columns</div>;
  return (
    <div className="border-border-dim bg-bg-secondary overflow-auto rounded-lg border">
      <table className="w-full border-collapse font-mono text-xs">
        <thead className="bg-bg-secondary sticky top-0">
          <tr>
            {result.columns.map((c) => (
              <th key={c.name} className="border-border-dim border-b px-3 py-2 text-left whitespace-nowrap">
                <span className="text-text-primary">{c.name}</span>
                <span className="text-text-dim block text-[10px] font-normal lowercase">{c.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="hover:bg-text-dim/[0.03] align-top">
              {result.columns.map((c) => (
                <td key={c.name} className="border-border-dim text-text-primary border-b px-3 py-1.5">
                  <Cell value={row[c.name]} />
                </td>
              ))}
            </tr>
          ))}
          {result.rows.length === 0 && (
            <tr>
              <td colSpan={result.columns.length} className="text-text-dim px-3 py-4 text-center">
                no rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
