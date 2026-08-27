function escapeCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Exposed for streaming exports, which cannot buffer every row before writing the first one. */
export function csvRow(cells: string[]): string {
  return cells.map(escapeCell).join(',');
}

export function buildCsv(headers: string[], rows: string[][]): string {
  return [csvRow(headers), ...rows.map(csvRow)].join('\n');
}
