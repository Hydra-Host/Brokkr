export interface ColumnDef {
  header: string;
  width: number;
}

export interface TableColumn<T> {
  header: string;
  accessor: (row: T) => string;
  width?: number;
}

// eslint-disable-next-line no-control-regex -- intentional ANSI/terminal control sequence
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

export function padCell(str: string, width: number): string {
  const visible = stripAnsi(str);
  if (visible.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - visible.length);
}

export function buildHLine(widths: number[], left: string, mid: string, right: string): string {
  return left + widths.map((w) => '─'.repeat(w)).join(mid) + right;
}

export function buildRow(cells: string[], widths: number[], border: string): string {
  const padded = cells.map((cell, i) => padCell(cell ?? '', widths[i]!));
  return border + padded.join(border) + border;
}

export function computeWidths<T>(
  columns: { header: string; width?: number; accessor: (row: T) => string }[],
  rows: T[],
  maxWidth?: number,
): number[] {
  const widths = columns.map((col) => {
    if (col.width) return col.width;
    const headerLen = col.header.length;
    const maxDataLen = rows.reduce((max, row) => {
      return Math.max(max, stripAnsi(col.accessor(row) ?? '').length);
    }, 0);
    return Math.max(headerLen, maxDataLen) + 2;
  });

  const termCols = maxWidth ?? process.stdout.columns ?? 120;
  const borderChars = columns.length + 1;
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + borderChars;

  if (totalWidth <= termCols) return widths;

  const available = termCols - borderChars;
  const minColWidth = 6;
  const scale = available / widths.reduce((sum, w) => sum + w, 0);
  const scaled = widths.map((w) => Math.max(minColWidth, Math.floor(w * scale)));

  let remainder = available - scaled.reduce((sum, w) => sum + w, 0);
  for (let i = 0; remainder > 0 && i < scaled.length; i++) {
    scaled[i] = (scaled[i] ?? minColWidth) + 1;
    remainder--;
  }

  let total = scaled.reduce((sum, w) => sum + w, 0);
  while (total > available && scaled.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < scaled.length; i++) {
      if ((scaled[i] ?? 0) > (scaled[maxIdx] ?? 0)) maxIdx = i;
    }
    scaled[maxIdx] = (scaled[maxIdx] ?? minColWidth) - 1;
    total--;
  }

  return scaled;
}
