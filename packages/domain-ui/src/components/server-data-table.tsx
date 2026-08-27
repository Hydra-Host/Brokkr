import type { Table as TableType } from '@tanstack/react-table';
import { Info, Loader2, Search, X } from 'lucide-react';
import { type MutableRefObject, type ReactNode, useEffect, useRef } from 'react';

import type { PaginationMeta } from '@repo/api-client';
import { DataTable } from '@repo/ui/components/data-table';
import { FilterBuilder } from '@repo/ui/components/filter-builder';
import { Input } from '@repo/ui/components/input';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip';
import type { useServerTable } from '../hooks/use-server-table';
import { ServerPagination } from './server-pagination';

interface ServerDataTableProps<TData> {
  table: ReturnType<typeof useServerTable<TData>>;
  data: TData[];
  meta?: PaginationMeta;
  isPending?: boolean;
  isFetching?: boolean;
  emptyMessage?: string;
  searchPlaceholder?: string;
  searchLabel?: string;
  searchableFields?: string[];
  toolbar?: ReactNode;
  renderTableActions?: (table: TableType<TData>) => ReactNode;
  onRowClick?: (row: TData) => void;
  onRowSelectionChange?: (count: number) => void;
  tableInstanceRef?: MutableRefObject<TableType<TData> | null>;
}

export function ServerDataTable<TData>({
  table,
  data,
  meta,
  isPending = false,
  isFetching = false,
  emptyMessage = 'No results.',
  searchPlaceholder = 'Search...',
  searchLabel = 'Search',
  searchableFields,
  toolbar,
  renderTableActions,
  onRowClick,
  onRowSelectionChange,
  tableInstanceRef,
}: ServerDataTableProps<TData>) {
  const hasFilters = table.filterFields && table.filterFields.length > 0;
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;

      if (e.key === '/' && !isEditing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }

      if (e.key === 'Escape' && tag === 'INPUT' && document.activeElement === searchRef.current) {
        searchRef.current?.blur();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 md:flex-nowrap md:gap-4">
        <div className="relative w-full shrink-0 md:w-auto">
          {isFetching ? (
            <Loader2 className="text-muted-foreground absolute top-1/2 left-2 z-10 h-4 w-4 -translate-y-1/2 animate-spin" />
          ) : (
            <Search className="text-muted-foreground absolute top-1/2 left-2 z-10 h-4 w-4 -translate-y-1/2" />
          )}
          <Input
            ref={searchRef}
            type="text"
            autoFocus={false}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            value={table.search}
            onChange={(e) => table.setSearch(e.target.value)}
            className={`h-10 w-full pl-8 md:w-[150px] lg:w-[300px] ${searchableFields?.length ? 'pr-14' : 'pr-8'}`}
          />
          <div className="absolute top-1/2 right-2 z-10 flex -translate-y-1/2 items-center gap-1.5">
            {searchableFields && searchableFields.length > 0 && (
              <Tooltip>
                <TooltipTrigger>
                  <Info className="text-muted-foreground hover:text-text-primary h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="font-sans">
                  <p className="mb-1 font-medium">Search by:</p>
                  <ul className="list-inside list-disc space-y-0.5">
                    {searchableFields.map((field) => (
                      <li key={field}>{field}</li>
                    ))}
                  </ul>
                </TooltipContent>
              </Tooltip>
            )}
            {table.search ? (
              <button
                type="button"
                onClick={() => table.setSearch('')}
                className="text-muted-foreground hover:text-text-primary cursor-pointer"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            ) : (
              <kbd className="border-border bg-bg-primary text-text-dim pointer-events-none rounded border px-1.5 py-0.5 font-mono text-[10px]">
                /
              </kbd>
            )}
          </div>
        </div>
        {hasFilters && (
          <FilterBuilder
            fields={table.filterFields!}
            activeFilters={table.activeFilters}
            onAdd={table.addFilter}
            onRemove={table.removeFilter}
            onClear={table.clearFilters}
          />
        )}
        {toolbar}
      </div>

      <div className="relative">
        {isFetching && !isPending && (
          <div className="bg-accent/10 absolute top-0 right-0 left-0 z-10 h-0.5 overflow-hidden">
            <div
              className="bg-accent/40 h-full w-1/3 animate-[shimmer_1s_ease-in-out_infinite]"
              style={{ animationName: 'shimmer' }}
            />
          </div>
        )}
        {isPending ? (
          <TableSkeleton columnCount={table.columns.length} />
        ) : (
          <div>
            <DataTable
              columns={table.columns}
              data={data}
              name={table.name}
              emptyMessage={emptyMessage}
              sorting={table.sorting}
              onSortingChange={table.onSortingChange}
              columnVisibility={table.columnVisibility}
              renderTableActions={renderTableActions}
              onRowClick={onRowClick}
              onRowSelectionChange={onRowSelectionChange}
              tableInstanceRef={tableInstanceRef}
            />
          </div>
        )}
      </div>

      {meta && !isPending && (
        <ServerPagination
          meta={meta}
          onPageChange={table.setPage}
          pageSize={table.pageSize}
          onPageSizeChange={table.setPageSize}
        />
      )}
    </div>
  );
}

function TableSkeleton({ columnCount }: { columnCount: number }) {
  const cols = Math.max(columnCount, 3);
  return (
    <div className="rounded-md border">
      <div className="border-b px-4 py-3">
        <div className="flex gap-6">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-24" />
          ))}
        </div>
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b px-4 py-3 last:border-b-0">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className="h-4 w-24" />
          ))}
        </div>
      ))}
    </div>
  );
}
