import { buildCsv } from '@repo/utils';

export function downloadCsvText(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function downloadCsv(headers: string[], rows: string[][], filename: string) {
  downloadCsvText(buildCsv(headers, rows), filename);
}
