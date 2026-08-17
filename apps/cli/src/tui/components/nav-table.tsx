import { Box, Text, useInput, useStdout } from 'ink';
import React, { useMemo, useState } from 'react';
import { useBackQuitKeys } from '../hooks.js';
import { buildHLine, buildRow, computeWidths, type TableColumn } from './table-renderer.js';

interface NavTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  onSelect?: (row: T, index: number) => void;
  onBack?: () => void;
  pageInfo?: string;
  onNextPage?: () => void;
  onPrevPage?: () => void;
}

export function NavTable<T>({ columns, rows, onSelect, onBack, pageInfo, onNextPage, onPrevPage }: NavTableProps<T>) {
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const { stdout } = useStdout();

  const chromeLines = 12;
  const termRows = (stdout?.rows ?? 40) - chromeLines;
  const visibleCount = Math.max(3, termRows);

  useBackQuitKeys(onBack);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        setScrollOffset((offset) => {
          if (next < offset) return next;
          return offset;
        });
        return next;
      });
    } else if (key.downArrow) {
      setCursor((c) => {
        const next = Math.min(rows.length - 1, c + 1);
        setScrollOffset((offset) => {
          if (next >= offset + visibleCount) return next - visibleCount + 1;
          return offset;
        });
        return next;
      });
    } else if (key.rightArrow && onNextPage) {
      onNextPage();
      setCursor(0);
      setScrollOffset(0);
    } else if (key.leftArrow && onPrevPage) {
      onPrevPage();
      setCursor(0);
      setScrollOffset(0);
    } else if (key.return && rows.length > 0 && onSelect) {
      onSelect(rows[cursor]!, cursor);
    }
  });

  const markerWidth = 3;
  const termCols = stdout?.columns ?? 120;
  const widths = useMemo(() => computeWidths(columns, rows, termCols - markerWidth), [columns, rows, termCols]);

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>No results found.</Text>
        <Box marginTop={1}>
          <Text>{onBack ? 'esc back  ' : ''}q quit</Text>
        </Box>
      </Box>
    );
  }

  const topBorder = '   ' + buildHLine(widths, '┌', '┬', '┐');
  const headerRow =
    '   ' +
    buildRow(
      columns.map((c) => c.header),
      widths,
      '│',
    );
  const headerSep = '   ' + buildHLine(widths, '├', '┼', '┤');
  const bottomBorder = '   ' + buildHLine(widths, '└', '┴', '┘');

  const visibleRows = rows.slice(scrollOffset, scrollOffset + visibleCount);
  const hasMore = scrollOffset + visibleCount < rows.length;
  const hasLess = scrollOffset > 0;

  const position = `${cursor + 1}/${rows.length}`;

  const hints = [
    position,
    pageInfo ? pageInfo : '',
    '↑↓ navigate',
    onNextPage || onPrevPage ? '←→ page' : '',
    onSelect ? '⏎ select' : '',
    onBack ? 'esc back' : '',
    'q quit',
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Box flexDirection="column">
      <Text>{topBorder}</Text>
      <Text bold>{headerRow}</Text>
      <Text>{headerSep}</Text>

      {hasLess && <Text> {'  ▲ more above'}</Text>}

      {visibleRows.map((row, visIdx) => {
        const realIdx = scrollOffset + visIdx;
        const selected = realIdx === cursor;
        const marker = selected ? ' ▸ ' : '   ';
        const rowStr = buildRow(
          columns.map((c) => c.accessor(row)),
          widths,
          '│',
        );
        return (
          <Text key={realIdx} color={selected ? 'cyan' : undefined} bold={selected}>
            {marker + rowStr}
          </Text>
        );
      })}

      {hasMore && <Text> {'  ▼ more below'}</Text>}

      <Text>{bottomBorder}</Text>

      <Box paddingX={1} marginTop={1}>
        <Text>{hints}</Text>
      </Box>
    </Box>
  );
}
