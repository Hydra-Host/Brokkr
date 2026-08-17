// a url-supplied page can sit past the last row, so the range is derived from what came back, never from the offset alone
export function rowRangeLabel(page: number, pageSize: number, rowCount: number): string {
  if (rowCount <= 0) return 'no rows';
  const first = page * pageSize + 1;
  return `rows ${first}–${first + rowCount - 1}`;
}
