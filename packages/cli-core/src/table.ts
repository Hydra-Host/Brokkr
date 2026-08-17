import chalk from 'chalk';

export interface ColumnDef<T> {
  header: string;
  get: (row: T) => string;
  align?: 'left' | 'right';
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const gap = Math.max(0, width - text.length);
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap);
}

export function renderTable<T>(columns: ColumnDef<T>[], rows: T[], footer?: string): void {
  const cells = rows.map((row) => columns.map((c) => c.get(row) ?? ''));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((r) => r[i]?.length ?? 0), 0));

  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bottom = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const headerRow =
    '│ ' + columns.map((c, i) => chalk.bold(pad(c.header, widths[i] ?? 0, c.align ?? 'left'))).join(' │ ') + ' │';

  console.log(top);
  console.log(headerRow);
  console.log(sep);
  for (const r of cells) {
    console.log('│ ' + r.map((cell, i) => pad(cell, widths[i] ?? 0, columns[i]?.align ?? 'left')).join(' │ ') + ' │');
  }
  console.log(bottom);
  if (footer) console.log(footer);
}
