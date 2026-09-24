import { Badge, type BadgeProps } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@repo/ui/components/select';
import { cn } from '@repo/ui/utils';
import { ArrowDown, Radio } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PagedLogTail } from '../hooks/use-paged-log-tail';

interface LogLevel {
  value: string;
  label: string;
  short: string;
  variant: NonNullable<BadgeProps['variant']>;
}

const LOG_LEVELS: LogLevel[] = [
  { value: 'debug', label: 'Debug', short: 'debug', variant: 'outline' },
  { value: 'info', label: 'Info', short: 'info', variant: 'outline' },
  { value: 'warning', label: 'Warning', short: 'warn', variant: 'warning' },
  { value: 'error', label: 'Error', short: 'error', variant: 'destructive' },
];

const LEVEL_ITEMS = [{ value: 'all', label: 'All levels' }, ...LOG_LEVELS];

// a reader a few pixels above the bottom still counts as pinned, so sub-pixel scroll drift does not unpin
const PIN_THRESHOLD_PX = 8;

function levelBadge(level: string): Pick<LogLevel, 'short' | 'variant'> {
  return LOG_LEVELS.find((item) => item.value === level) ?? { short: level, variant: 'outline' };
}

function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

type LogStreamTail = Pick<PagedLogTail, 'entries' | 'hasMore' | 'isFetchingMore' | 'loadMore' | 'isTailing'>;

interface LogStreamViewProps {
  tail: LogStreamTail;
  ariaLabel: string;
  emptyMessage: string;
  waitingMessage: string;
  /** Fill the parent's height and scroll the log inside it instead of capping it at 32rem. */
  fill?: boolean;
  showLevelFilter?: boolean;
}

export function LogStreamView({
  tail,
  ariaLabel,
  emptyMessage,
  waitingMessage,
  fill = false,
  showLevelFilter = true,
}: LogStreamViewProps) {
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tail.entries.filter((entry) => {
      if (level !== 'all' && entry.logLevel.toLowerCase() !== level) return false;
      return query === '' || entry.message.toLowerCase().includes(query);
    });
  }, [tail.entries, level, search]);

  useEffect(() => {
    const element = scrollRef.current;
    if (pinned && element) element.scrollTop = element.scrollHeight;
  }, [filtered, pinned]);

  const hasRows = filtered.length > 0;
  useEffect(() => {
    const element = scrollRef.current;
    // a hidden keepMounted panel loses its scrollTop, so re-pin when the log regains a size
    if (!pinned || !hasRows || element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pinned, hasRows]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_THRESHOLD_PX);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setPinned(true);
  };

  return (
    <div className={cn('flex flex-col gap-3', fill && 'h-full min-h-0')}>
      <div className="flex items-center gap-3">
        {showLevelFilter && (
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger className="w-[160px]">
              {LEVEL_ITEMS.find((item) => item.value === level)?.label}
            </SelectTrigger>
            <SelectContent>
              {LEVEL_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          placeholder="Search messages"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-sm"
        />
      </div>
      {tail.entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">{tail.isTailing ? waitingMessage : emptyMessage}</p>
      ) : !hasRows ? (
        <p className="text-muted-foreground text-sm">No entries match the current filters.</p>
      ) : (
        <div className={cn('relative', fill && 'min-h-0 flex-1')}>
          <div
            ref={scrollRef}
            role="log"
            aria-live="off"
            aria-label={ariaLabel}
            onScroll={onScroll}
            className={cn(
              'overflow-y-auto rounded-md border py-1 font-mono text-xs',
              fill ? 'h-full' : 'max-h-[32rem]',
            )}
          >
            {filtered.map((entry) => {
              const badge = levelBadge(entry.logLevel.toLowerCase());
              const appClassName = entry.appClassName && entry.appClassName !== 'unknown' ? entry.appClassName : null;
              return (
                <div key={entry.id} className="hover:bg-muted/50 flex items-start gap-2 px-2 py-0.5">
                  <time dateTime={entry.timestamp} className="text-muted-foreground w-24 shrink-0 tabular-nums">
                    {formatLogTime(entry.timestamp)}
                  </time>
                  {showLevelFilter && (
                    <Badge variant={badge.variant} size="sm" className="w-14 shrink-0 justify-center">
                      {badge.short}
                    </Badge>
                  )}
                  <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{entry.message}</span>
                  {appClassName && <span className="text-muted-foreground shrink-0 text-right">{appClassName}</span>}
                </div>
              );
            })}
          </div>
          {!pinned && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="absolute right-3 bottom-3 shadow"
              onClick={jumpToLatest}
            >
              <ArrowDown className="mr-1 h-3 w-3" />
              Jump to latest
            </Button>
          )}
        </div>
      )}
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        {tail.hasMore && (
          <Button variant="outline" size="sm" disabled={tail.isFetchingMore} onClick={tail.loadMore}>
            Load more
          </Button>
        )}
        {tail.isTailing && (
          <span className="inline-flex items-center gap-1">
            <Radio className="h-3 w-3 animate-pulse" />
            Following live output
          </span>
        )}
      </div>
    </div>
  );
}
