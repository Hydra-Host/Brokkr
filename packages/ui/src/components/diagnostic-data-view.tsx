import { formatCellValue, formatColumnHeader, isPrimitive, isRecord, isRowArray } from '@repo/utils';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { DataTable } from './data-table';

type Row = Record<string, unknown>;

export type DiagnosticStatus = 'fail' | 'warn' | 'pass';

/** Row keys that clutter diagnostic tables (metadata / availability flags). */
export const DIAGNOSTIC_SKIP_KEYS = new Set([
  'errors',
  'warnings',
  'timestamp',
  'systemctl_available',
  'cuda_available',
  'num_gpus',
  'total_gpus',
]);

function diagnosticMessage(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function extractDiagnosticErrors(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const errors = Array.isArray(data.errors) ? data.errors.map(diagnosticMessage) : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings.map(diagnosticMessage) : [];
  return [...errors, ...warnings];
}

export function deriveDiagnosticStatus(data: unknown): DiagnosticStatus {
  if (!isRecord(data)) return 'pass';
  if (Array.isArray(data.errors) && data.errors.length > 0) return 'fail';
  if (Array.isArray(data.warnings) && data.warnings.length > 0) return 'warn';
  return 'pass';
}

function cellClassName(key: string, value: unknown): string | undefined {
  if (value === false && (key.includes('success') || key.includes('active'))) {
    return 'font-medium text-red-500';
  }
  if (value === true && (key.includes('success') || key.includes('active'))) {
    return 'text-green-500';
  }
  if (key.includes('status') && value === 'failed') return 'font-medium text-red-500';
  if (key.includes('status') && value === 'active') return 'text-green-500';
  if (key.includes('error') && typeof value === 'string' && value.length > 0) {
    return 'font-medium text-red-500';
  }
  if (key.includes('failure') && value === true) return 'font-medium text-red-500';
  return undefined;
}

function buildColumns(rows: Row[]): ColumnDef<Row>[] {
  const keyOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key) || DIAGNOSTIC_SKIP_KEYS.has(key)) continue;
      seen.add(key);
      keyOrder.push(key);
    }
  }

  const tabularKeys = keyOrder.filter((key) => rows.some((row) => isPrimitive(row[key])));

  return tabularKeys.map((key) => ({
    id: key,
    header: formatColumnHeader(key),
    accessorFn: (row) => row[key],
    cell: ({ getValue }) => {
      const value = getValue();
      const className = cellClassName(key, value);
      return <span className={className}>{formatCellValue(value)}</span>;
    },
  }));
}

function flattenServicesMap(services: unknown): Row[] | null {
  if (!isRecord(services)) return null;
  const rows = Object.entries(services).map(([name, svc]) => ({
    name,
    ...(isRecord(svc) ? svc : {}),
  }));
  return rows.length > 0 ? rows : null;
}

export function DiagnosticDataView({ data }: { data: unknown }) {
  if (!isRecord(data)) {
    return <p className="text-muted-foreground text-sm">No structured payload was recorded.</p>;
  }

  const servicesRows = flattenServicesMap(data.services);
  const scalarEntries = Object.entries(data).filter(([, value]) => isPrimitive(value));
  const objectEntries = Object.entries(data).filter(([key, value]) => {
    if (key === 'services' && servicesRows) return false;
    return isRecord(value);
  });
  const tables: Array<[string, Row[]]> = [];
  if (servicesRows) tables.push(['Services', servicesRows]);
  for (const [key, value] of Object.entries(data)) {
    if (key === 'errors' || key === 'warnings' || key === 'services') continue;
    if (isRowArray(value)) tables.push([formatColumnHeader(key), value]);
  }

  if (scalarEntries.length === 0 && objectEntries.length === 0 && tables.length === 0) {
    return <p className="text-muted-foreground text-sm">No structured payload was recorded.</p>;
  }

  return (
    <div className="space-y-4">
      {scalarEntries.length > 0 && (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {scalarEntries.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{formatColumnHeader(key)}</dt>
              <dd className="text-right">{formatCellValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {objectEntries.map(([key, value]) => (
        <section key={key} className="space-y-2">
          <h4 className="text-muted-foreground text-xs font-medium">{formatColumnHeader(key)}</h4>
          <DiagnosticDataView data={value} />
        </section>
      ))}
      {tables.map(([label, rows]) => (
        <div key={label}>
          <h4 className="text-muted-foreground mb-2 text-xs font-medium">{label}</h4>
          <DataTable columns={buildColumns(rows)} data={rows} emptyMessage="No data" />
        </div>
      ))}
    </div>
  );
}

export function DiagnosticStatusIcon({ status }: { status: DiagnosticStatus }) {
  switch (status) {
    case 'fail':
      return <XCircle className="h-4 w-4 text-red-500" aria-label="Failed" />;
    case 'warn':
      return <AlertTriangle className="h-4 w-4 text-yellow-500" aria-label="Warning" />;
    case 'pass':
      return <CheckCircle className="h-4 w-4 text-green-500" aria-label="Passed" />;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
