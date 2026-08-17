import { Box, Text } from 'ink';
import React, { useMemo } from 'react';
import { buildHLine, buildRow, computeWidths, type TableColumn } from './table-renderer.js';

interface StaticTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  title?: string;
  footer?: string;
}

export function StaticTable<T>({ columns, rows, title, footer }: StaticTableProps<T>) {
  const widths = useMemo(() => computeWidths(columns, rows), [columns, rows]);

  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        {title && <Text bold>{title}</Text>}
        <Text>No results found.</Text>
      </Box>
    );
  }

  const topBorder = buildHLine(widths, '┌', '┬', '┐');
  const headerRow = buildRow(
    columns.map((c) => c.header),
    widths,
    '│',
  );
  const headerSep = buildHLine(widths, '├', '┼', '┤');
  const bottomBorder = buildHLine(widths, '└', '┴', '┘');

  return (
    <Box flexDirection="column">
      {title && (
        <Box marginBottom={0}>
          <Text bold>{title}</Text>
        </Box>
      )}
      <Text>{topBorder}</Text>
      <Text bold>{headerRow}</Text>
      <Text>{headerSep}</Text>
      {rows.map((row, idx) => (
        <Text key={idx}>
          {buildRow(
            columns.map((c) => c.accessor(row)),
            widths,
            '│',
          )}
        </Text>
      ))}
      <Text>{bottomBorder}</Text>
      {footer && <Text>{footer}</Text>}
    </Box>
  );
}
