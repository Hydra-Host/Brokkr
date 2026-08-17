import { buildCsv } from '@repo/utils';

export function downloadCsv(headers: string[], rows: string[][], filename: string) {
  const csvContent = buildCsv(headers, rows);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
