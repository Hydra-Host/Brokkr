import { useEffect, useMemo, useState } from 'react';

import type { JobLogEntry } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@repo/ui/components/select';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { tsr } from '~/lib/api';

const LEVEL_ITEMS = [
  { value: 'all', label: 'All levels' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

function levelBadgeVariant(level: string): 'destructive' | 'secondary' | 'outline' {
  if (level === 'error') return 'destructive';
  if (level === 'warning') return 'secondary';
  return 'outline';
}

interface LogAccumulation {
  entries: JobLogEntry[];
  nextCursor: string | null;
}

export function JobLogViewer({ jobId }: { jobId: string }) {
  const [cursor, setCursor] = useState<string>();
  const [accumulation, setAccumulation] = useState<LogAccumulation>({ entries: [], nextCursor: null });
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');

  const { data, isPending, isFetching, isError } = tsr.getJobLogs.useQuery({
    queryKey: ['job-logs', jobId, cursor],
    queryData: { params: { jobId }, query: { cursor, limit: 500 } },
  });

  useEffect(() => {
    if (data?.status !== 200) return;
    const page = data.body;
    setAccumulation((previous) => {
      const seen = new Set(previous.entries.map((entry) => entry.id));
      return {
        entries: [...previous.entries, ...page.entries.filter((entry) => !seen.has(entry.id))],
        nextCursor: page.nextCursor,
      };
    });
  }, [data]);

  const { entries, nextCursor } = accumulation;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (level !== 'all' && entry.logLevel.toLowerCase() !== level) return false;
      return query === '' || entry.message.toLowerCase().includes(query);
    });
  }, [entries, level, search]);

  if (isError) {
    return <p className="text-muted-foreground text-sm">Failed to load job logs.</p>;
  }

  if (isPending && entries.length === 0) {
    return <Skeleton className="h-40 w-full" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger className="w-[160px]">{LEVEL_ITEMS.find((item) => item.value === level)?.label}</SelectTrigger>
          <SelectContent>
            {LEVEL_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Search messages"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-sm"
        />
      </div>
      {filtered.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {entries.length === 0 ? 'No log entries for this job.' : 'No entries match the current filters.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Level</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap">{new Date(entry.timestamp).toLocaleString()}</TableCell>
                <TableCell>
                  <Badge variant={levelBadgeVariant(entry.logLevel.toLowerCase())} size="sm">
                    {entry.logLevel.toLowerCase()}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs break-all">
                  {entry.message}
                  {entry.appClassName && <span className="text-muted-foreground ml-2">{entry.appClassName}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {nextCursor !== null && (
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => setCursor(nextCursor)}>
          Load more
        </Button>
      )}
    </div>
  );
}
