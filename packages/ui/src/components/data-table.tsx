import {
  ColumnDef,
  ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  PaginationState,
  Row,
  SortingState,
  useReactTable,
  VisibilityState,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  ClipboardCheck,
  Filter,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { Column, Table as TableType } from '@tanstack/react-table';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu';
import { Input } from './input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { cn } from './utils';

interface SearchableColumn {
  id: string;
  title: string;
}

export type ColumnBackgroundColors = Record<string, string>;

export type FilterOption = {
  label: string;
  value: string;
  count?: number;
};

export type DataTableFilter = {
  id: string;
  label: string;
  lowercase?: boolean;
  options: FilterOption[];
};

interface DataTableProps<TData, TValue> {
  className?: string;
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  name?: string;
  enableColumnVisbility?: boolean;
  enablePagination?: boolean;
  searchableColumns?: SearchableColumn[];
  filters?: DataTableFilter[];
  globalFilterFn?: (row: Row<TData>, columnId: string, filterValue: string) => boolean;
  tableContainerClassName?: string;
  defaultPageSize?: number;
  renderTableActions?: (table: TableType<TData>) => React.ReactNode;
  tableInstanceRef?: React.MutableRefObject<TableType<TData> | null>;
  onRowSelectionChange?: (count: number) => void;
  emptyState?: React.ReactNode;
  emptyMessage?: string;
  forceFiltersBelow?: boolean;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  columnVisibility?: VisibilityState;
  onRowClick?: (row: TData) => void;
}

const LONG_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{24,})$/i;

type IconNodeDef = [string, Record<string, string>][];

// Local copy of the row-id check: @repo/ui is dependency-free by design (it is
// mirrored into the Commerce repo), so it cannot import @repo/utils' isRecord.
function extractRowId(row: unknown): string | undefined {
  return row != null && typeof row === 'object' && 'id' in row && row.id != null ? String(row.id) : undefined;
}

const CLIPBOARD_ICON: IconNodeDef = [
  ['rect', { width: '8', height: '4', x: '8', y: '2', rx: '1', ry: '1' }],
  ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }],
];

const CLIPBOARD_CHECK_ICON: IconNodeDef = [...CLIPBOARD_ICON, ['path', { d: 'm9 14 2 2 4-4' }]];

function createSvgIcon(nodes: IconNodeDef, size = 14): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [attr, val] of Object.entries({
    xmlns: NS,
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })) {
    svg.setAttribute(attr, val);
  }
  for (const [tag, attrs] of nodes) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function CellContentWrapper({ children }: { children: React.ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [truncatedItems, setTruncatedItems] = useState<{ text: string; top: number; height: number }[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const truncListenersRef = useRef<Array<{ el: Element; enter: (e: Event) => void; leave: () => void }>>([]);
  const [uuidValue, setUuidValue] = useState<string | null>(null);

  interface UuidMutation {
    originalText: string;
    savedStyles: { display: string; alignItems: string; gap: string };
    hadTitle: boolean;
    savedTitle: string;
    onEnter?: (e: MouseEvent) => void;
    onLeave?: () => void;
  }
  const uuidMapRef = useRef(new Map<Node, UuidMutation>());
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  function rollbackMutations() {
    for (const [node, mutation] of uuidMapRef.current) {
      if (node.parentNode) node.textContent = mutation.originalText;
      if (node.parentElement) {
        const parent = node.parentElement;
        parent.style.display = mutation.savedStyles.display;
        parent.style.alignItems = mutation.savedStyles.alignItems;
        parent.style.gap = mutation.savedStyles.gap;
        if (mutation.hadTitle) {
          parent.title = mutation.savedTitle;
        } else {
          parent.removeAttribute('title');
        }
        parent.querySelectorAll('[data-uuid-copy]').forEach((btn) => btn.remove());
        if (mutation.onEnter) parent.removeEventListener('mouseenter', mutation.onEnter);
        if (mutation.onLeave) parent.removeEventListener('mouseleave', mutation.onLeave);
      }
    }
    uuidMapRef.current.clear();
  }

  function clearTimers() {
    for (const id of timersRef.current) clearTimeout(id);
    timersRef.current.clear();
  }

  // Deps intentionally omitted: cell content can change any render; setUuidValue with same value is a no-op, so no loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return rollbackMutations;

    rollbackMutations();
    clearTimers();

    const fullText = el.textContent?.trim() ?? '';

    if (!el.children.length && LONG_ID_RE.test(fullText)) {
      setUuidValue(fullText);
      return rollbackMutations;
    }

    setUuidValue(null);

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent?.trim() ?? '';
      if (LONG_ID_RE.test(text) && textNode.parentElement) {
        const parent = textNode.parentElement;
        const onEnter = (e: MouseEvent) => {
          const r = (e.currentTarget as Element).getBoundingClientRect();
          setHoverTooltip({ text, x: r.left, y: r.top });
        };
        const onLeave = () => setHoverTooltip(null);
        uuidMapRef.current.set(textNode, {
          originalText: textNode.textContent!,
          savedStyles: {
            display: parent.style.display,
            alignItems: parent.style.alignItems,
            gap: parent.style.gap,
          },
          hadTitle: parent.hasAttribute('title'),
          savedTitle: parent.title,
          onEnter,
          onLeave,
        });
        parent.style.display = 'inline-flex';
        parent.style.alignItems = 'center';
        parent.style.gap = '4px';
        textNode.textContent = `...${text.slice(-6)}`;
        parent.addEventListener('mouseenter', onEnter);
        parent.addEventListener('mouseleave', onLeave);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-uuid-copy', '');
        btn.className = 'shrink-0 rounded p-0.5 hover:bg-muted';
        btn.style.color = 'var(--color-muted-foreground)';
        btn.replaceChildren(createSvgIcon(CLIPBOARD_ICON));
        btn.onclick = (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(text);
          btn.replaceChildren(createSvgIcon(CLIPBOARD_CHECK_ICON));
          btn.style.color = 'rgb(16, 185, 129)';
          const id = setTimeout(() => {
            timersRef.current.delete(id);
            btn.replaceChildren(createSvgIcon(CLIPBOARD_ICON));
            btn.style.color = 'var(--color-muted-foreground)';
          }, 2000);
          timersRef.current.add(id);
        };
        parent.appendChild(btn);
      }
    }

    return () => {
      rollbackMutations();
      clearTimers();
    };
  });

  function cleanupTruncListeners() {
    for (const { el, enter, leave } of truncListenersRef.current) {
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mouseleave', leave);
    }
    truncListenersRef.current = [];
  }

  const checkTruncation = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;

    cleanupTruncListeners();

    const containerRect = el.getBoundingClientRect();
    const overflowing: Element[] = [];
    const descendants = el.getElementsByTagName('*');
    for (let i = 0; i < descendants.length; i++) {
      const d = descendants[i];
      if (d.scrollWidth > d.clientWidth) overflowing.push(d);
    }

    const leafElements = overflowing.filter((el) => !overflowing.some((other) => other !== el && el.contains(other)));

    const items: { text: string; top: number; height: number }[] = [];
    for (const d of leafElements) {
      const text = d.textContent?.trim();
      if (!text) continue;
      const rect = d.getBoundingClientRect();
      items.push({ text, top: rect.top - containerRect.top, height: rect.height });

      const enter = (e: Event) => {
        const r = (e.currentTarget as Element).getBoundingClientRect();
        setHoverTooltip({ text, x: r.left, y: r.top });
      };
      const leave = () => setHoverTooltip(null);
      d.addEventListener('mouseenter', enter);
      d.addEventListener('mouseleave', leave);
      truncListenersRef.current.push({ el: d, enter, leave });
    }

    if (items.length === 0 && el.scrollWidth > el.clientWidth) {
      const text = el.textContent?.trim();
      if (text) items.push({ text, top: 0, height: el.clientHeight });
    }

    setTruncatedItems(items);
  }, []);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const text = uuidValue ?? contentRef.current?.textContent ?? '';
      navigator.clipboard.writeText(text);
      setCopied(true);
      const id = setTimeout(() => {
        timersRef.current.delete(id);
        setCopied(false);
      }, 2000);
      timersRef.current.add(id);
    },
    [uuidValue],
  );

  const handleCopyItem = useCallback((e: React.MouseEvent, text: string, index: number) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      setCopiedIndex(null);
    }, 2000);
    timersRef.current.add(id);
  }, []);

  if (uuidValue) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <span
          className="text-muted-foreground font-mono text-sm"
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHoverTooltip({ text: uuidValue, x: r.left, y: r.top });
          }}
          onMouseLeave={() => setHoverTooltip(null)}
        >
          ...{uuidValue.slice(-6)}
        </span>
        <button type="button" onClick={handleCopy} className="hover:bg-muted shrink-0 rounded p-0.5">
          {copied ? (
            <ClipboardCheck className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Clipboard className="text-muted-foreground h-3.5 w-3.5" />
          )}
        </button>
        <div ref={contentRef} className="hidden">
          {children}
        </div>
        {hoverTooltip &&
          createPortal(
            <div
              className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 pointer-events-none fixed z-100 max-w-xs rounded-md border px-3 py-1.5 text-sm break-all shadow-md"
              style={{ left: hoverTooltip.x, top: hoverTooltip.y - 8, transform: 'translateY(-100%)' }}
            >
              {hoverTooltip.text}
            </div>,
            document.body,
          )}
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 items-center gap-1"
      onMouseEnter={checkTruncation}
      onMouseLeave={() => {
        cleanupTruncListeners();
        setTruncatedItems([]);
        setCopiedIndex(null);
        setHoverTooltip(null);
      }}
    >
      <div ref={contentRef} className="min-w-0 flex-1 truncate [&_*]:overflow-hidden [&_*]:text-ellipsis">
        {children}
      </div>
      {truncatedItems.length > 0 && (
        <div className="relative shrink-0 self-stretch" style={{ width: 22 }}>
          {truncatedItems.map((item, idx) => (
            <button
              key={idx}
              type="button"
              onClick={(e) => handleCopyItem(e, item.text, idx)}
              className="hover:bg-muted absolute shrink-0 rounded p-0.5"
              style={{ top: item.top + (item.height - 18) / 2 }}
            >
              {copiedIndex === idx ? (
                <ClipboardCheck className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Clipboard className="text-muted-foreground h-3.5 w-3.5" />
              )}
            </button>
          ))}
        </div>
      )}
      {hoverTooltip &&
        createPortal(
          <div
            className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 pointer-events-none fixed z-100 max-w-xs rounded-md border px-3 py-1.5 text-sm break-all shadow-md"
            style={{ left: hoverTooltip.x, top: hoverTooltip.y - 8, transform: 'translateY(-100%)' }}
          >
            {hoverTooltip.text}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function DataTable<TData, TValue>({
  columns,
  data,
  name = 'default',
  searchableColumns,
  globalFilterFn,
  filters,
  enableColumnVisbility = false,
  enablePagination = false,
  tableContainerClassName,
  defaultPageSize = 10,
  renderTableActions,
  tableInstanceRef,
  onRowSelectionChange,
  emptyState,
  emptyMessage = 'No results.',
  forceFiltersBelow = false,
  sorting: controlledSorting,
  onSortingChange: controlledOnSortingChange,
  columnVisibility: controlledColumnVisibility,
  onRowClick,
}: DataTableProps<TData, TValue>) {
  const isManualSorting = controlledSorting !== undefined;
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const sorting = isManualSorting ? controlledSorting : internalSorting;
  const setSorting = isManualSorting
    ? (updater: SortingState | ((prev: SortingState) => SortingState)) => {
        const next = typeof updater === 'function' ? updater(controlledSorting) : updater;
        controlledOnSortingChange?.(next);
      }
    : setInternalSorting;
  const [globalFilter, setGlobalFilter] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(`table-global-filter-${name}`);
      return saved || '';
    }
    return '';
  });
  const [rowSelection, setRowSelectionRaw] = useState({});
  const prevDataRef = useRef(data);
  const selectionClearedRef = useRef(false);
  if (data !== prevDataRef.current) {
    prevDataRef.current = data;
    if (Object.keys(rowSelection).length > 0) {
      setRowSelectionRaw({});
      selectionClearedRef.current = true;
    }
  }
  useEffect(() => {
    if (selectionClearedRef.current) {
      selectionClearedRef.current = false;
      onRowSelectionChange?.(0);
    }
  });
  const setRowSelection = useCallback(
    (updater: React.SetStateAction<Record<string, boolean>>) => {
      setRowSelectionRaw((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        onRowSelectionChange?.(Object.keys(next).filter((k) => next[k]).length);
        return next;
      });
    },
    [onRowSelectionChange],
  );
  const [columnDropdownOpen, setColumnDropdownOpen] = useState(false);
  const [pagination, setPagination] = useState<PaginationState>(() => {
    if (typeof window !== 'undefined') {
      const savedPageSize = localStorage.getItem(`table-page-size-${name}`);
      return {
        pageIndex: 0,
        pageSize: savedPageSize ? parseInt(savedPageSize, 10) : defaultPageSize,
      };
    }
    return { pageIndex: 0, pageSize: defaultPageSize };
  });

  const handleSearch = useCallback((value: string) => {
    setGlobalFilter(value);
  }, []);

  const storageKey = `table-column-visibility-${name}`;
  const filterStorageKey = `table-filters-${name}`;
  const pageSizeStorageKey = `table-page-size-${name}`;

  const [internalColumnVisibility, setInternalColumnVisibility] = useState<VisibilityState>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (error) {
          console.warn('Failed to parse saved column visibility', error);
        }
      }
    }
    return {};
  });
  const columnVisibility = controlledColumnVisibility ?? internalColumnVisibility;
  const setColumnVisibility = setInternalColumnVisibility;

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(filterStorageKey);
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (error) {
          console.warn('Failed to parse saved table filters', error);
        }
      }
    }
    return [];
  });

  const [filterSearchValues, setFilterSearchValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (typeof window !== 'undefined' && enableColumnVisbility && columnVisibility !== undefined) {
      localStorage.setItem(storageKey, JSON.stringify(columnVisibility));
    }
  }, [columnVisibility, storageKey, enableColumnVisbility]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(filterStorageKey, JSON.stringify(columnFilters));
    }
  }, [columnFilters, filterStorageKey]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`table-global-filter-${name}`, globalFilter);
    }
  }, [globalFilter, name]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(pageSizeStorageKey, pagination.pageSize.toString());
    }
  }, [pagination.pageSize, pageSizeStorageKey]);

  const getColumnLabel = (column: Column<TData>) => {
    if (typeof column.columnDef.header === 'string') {
      return column.columnDef.header;
    }
    if (typeof column.columnDef.header === 'function') {
      const headerContext = { column, header: column.columnDef.header, table } as any;
      const headerContent = column.columnDef.header(headerContext);
      if (typeof headerContent === 'string') return headerContent;
      if (headerContent?.type?.name === 'DataTableSortHeader' && headerContent.props?.label) {
        return headerContent.props.label;
      }
      if (headerContent?.props?.children && typeof headerContent.props.children === 'string') {
        return headerContent.props.children;
      }
    }
    return column.id || 'Unknown Column';
  };

  const table = useReactTable({
    data,
    columns,
    getRowId: (row, index) => extractRowId(row) ?? String(index),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: isManualSorting,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    ...(!isManualSorting && { getSortedRowModel: getSortedRowModel() }),
    getFilteredRowModel: getFilteredRowModel(),
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    ...(globalFilterFn ? { globalFilterFn } : {}),
    state: {
      sorting,
      rowSelection,
      columnFilters,
      globalFilter: (globalFilter ?? '').trim(),
      columnVisibility,
      ...(enablePagination && { pagination }),
    },
    onGlobalFilterChange: setGlobalFilter,
    ...(enablePagination && { getPaginationRowModel: getPaginationRowModel() }),
    ...(enablePagination && { onPaginationChange: setPagination }),
  });

  if (tableInstanceRef) {
    tableInstanceRef.current = table;
  }

  const minTableWidth = table.getVisibleLeafColumns().reduce((sum, col) => sum + (col.columnDef.size || 150), 0);

  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-1 items-center space-x-2">
          {searchableColumns && (
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-3 z-10 h-4 w-4 -translate-y-1/2" />
              <Input
                placeholder="Search columns..."
                value={globalFilter ?? ''}
                onChange={(event) => handleSearch(event.target.value)}
                className="h-10 w-[150px] pl-9 lg:w-[250px]"
              />
            </div>
          )}

          {(columnFilters.length > 0 || globalFilter) && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                table.resetColumnFilters();
                setGlobalFilter('');
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {enableColumnVisbility && (
            <DropdownMenu open={columnDropdownOpen} onOpenChange={setColumnDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="ml-auto hidden h-8 lg:flex">
                  <SlidersHorizontal className="h-4 w-4" />
                  View
                  {table.getAllColumns().filter((col) => col.getCanHide() && col.getIsVisible()).length > 0 && (
                    <span className="bg-primary text-primary-foreground rounded-lg px-1.5 py-0.5 text-xs">
                      {table.getAllColumns().filter((col) => col.getCanHide() && col.getIsVisible()).length}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[200px] pt-0">
                <div className="bg-popover sticky top-0 z-10 flex justify-between gap-2 border-b p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => {
                      table
                        .getAllColumns()
                        .filter((col) => col.getCanHide())
                        .forEach((col) => col.toggleVisibility(true));
                    }}
                  >
                    All
                  </Button>
                </div>
                {table
                  .getAllColumns()
                  .filter((col) => col.getCanHide())
                  .map((col) => (
                    <div
                      key={col.id}
                      className="hover:bg-accent/10 flex cursor-pointer items-center px-2 py-1.5 text-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        col.toggleVisibility(!col.getIsVisible());
                      }}
                    >
                      <Checkbox
                        checked={col.getIsVisible()}
                        className="mr-2"
                        onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                      />
                      <span>{getColumnLabel(col)}</span>
                    </div>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {filters && filters.length > 0 && !forceFiltersBelow && (
            <FilterDropdowns
              filters={filters}
              table={table}
              filterSearchValues={filterSearchValues}
              setFilterSearchValues={setFilterSearchValues}
            />
          )}
        </div>
      </div>

      {filters && forceFiltersBelow && (
        <div className="flex flex-wrap gap-2">
          <FilterDropdowns
            filters={filters}
            table={table}
            filterSearchValues={filterSearchValues}
            setFilterSearchValues={setFilterSearchValues}
          />
        </div>
      )}

      <div className="overflow-x-auto">
        <Table containerClassName={cn('h-auto', tableContainerClassName)} style={{ minWidth: minTableWidth }}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    style={header.column.columnDef.size ? { width: header.column.columnDef.size } : undefined}
                    className="text-accent h-12 px-4 text-left align-middle font-mono text-xs font-bold tracking-wide uppercase [&:has([role=checkbox])]:pr-0"
                  >
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={onRowClick ? 'cursor-pointer' : undefined}
                  onClick={(e) => {
                    if (!onRowClick || e.defaultPrevented) return;
                    const selection = window.getSelection();
                    if (selection && selection.toString().length > 0) return;
                    const target = e.target as HTMLElement;
                    if (target.closest('a, button, input, [role="checkbox"]')) return;
                    onRowClick(row.original);
                  }}
                >
                  {row.getVisibleCells().map((cell) => {
                    const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                    return (
                      <TableCell
                        key={cell.id}
                        style={cell.column.columnDef.size ? { width: cell.column.columnDef.size } : undefined}
                      >
                        {cell.column.id === 'select' ||
                        (cell.column.columnDef as unknown as { noTruncate?: boolean }).noTruncate ? (
                          content
                        ) : (
                          <CellContentWrapper>{content}</CellContentWrapper>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {(enablePagination || searchableColumns) && (
        <div className="flex items-center justify-between px-2">
          <div className="text-muted-foreground flex-1 text-sm">
            {table.getColumn('select')?.getIsVisible() && (
              <p className="pb-4">
                {table.getFilteredSelectedRowModel().rows.length} of {table.getFilteredRowModel().rows.length} row(s)
                selected.
              </p>
            )}
            {searchableColumns && (
              <div className="ml-auto text-sm font-bold whitespace-nowrap">
                {table.getFilteredRowModel().rows.length} total rows match your filters
              </div>
            )}
          </div>
          {enablePagination && table.getFilteredRowModel().rows.length !== 0 && (
            <div className="flex items-center space-x-6 lg:space-x-8">
              <div className="flex items-center space-x-2">
                <p className="text-sm font-medium">Rows per page</p>
                <Select
                  value={`${table.getState().pagination.pageSize}`}
                  onValueChange={(value) => table.setPageSize(Number(value))}
                >
                  <SelectTrigger className="h-8 w-[70px]">
                    <SelectValue placeholder={table.getState().pagination.pageSize} />
                  </SelectTrigger>
                  <SelectContent side="top">
                    {[5, 10, 25, 50].map((pageSize) => (
                      <SelectItem key={pageSize} value={`${pageSize}`}>
                        {pageSize}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-[100px] items-center justify-center text-sm font-medium">
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  className="hidden h-8 w-8 rounded-none p-0 lg:flex"
                  onClick={() => table.setPageIndex(0)}
                  disabled={!table.getCanPreviousPage()}
                >
                  <span className="sr-only">Go to first page</span>
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  className="h-8 w-8 rounded-none p-0"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  <span className="sr-only">Go to previous page</span>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  className="h-8 w-8 rounded-none p-0"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  <span className="sr-only">Go to next page</span>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  className="hidden h-8 w-8 rounded-none p-0 lg:flex"
                  onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                  disabled={!table.getCanNextPage()}
                >
                  <span className="sr-only">Go to last page</span>
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {table.getFilteredSelectedRowModel().rows.map((row) => {
        const rowId = extractRowId(row.original);
        return <input key={rowId} type="hidden" name={name} value={rowId} />;
      })}

      {table.getFilteredSelectedRowModel().rows.length > 0 && renderTableActions && (
        <div className="bg-background fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-lg border px-8 py-4 whitespace-nowrap shadow-lg">
          <span className="font-medium">{table.getFilteredSelectedRowModel().rows.length} selected</span>
          {renderTableActions(table)}
        </div>
      )}
    </div>
  );
}

function FilterDropdowns<TData>({
  filters,
  table,
  filterSearchValues,
  setFilterSearchValues,
}: {
  filters: DataTableFilter[];
  table: TableType<TData>;
  filterSearchValues: Record<string, string>;
  setFilterSearchValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  return (
    <>
      {filters.map((filter) => {
        const column = table.getColumn(filter.id);
        const filterValues = (column?.getFilterValue() as string[]) || [];
        const selectedCount = filterValues.length;

        return (
          <DropdownMenu key={filter.id}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 capitalize">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4" />
                  <span>{filter.label}</span>
                  {selectedCount > 0 && (
                    <span className="bg-primary text-primary-foreground rounded-lg px-1.5 py-0.5 text-xs">
                      {selectedCount}
                    </span>
                  )}
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[300px] max-w-fit overflow-y-auto pt-0">
              <div className="bg-popover sticky top-0 z-10 flex justify-between gap-2 border-b p-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => {
                    const allValues = filter.options.map((opt) => opt.value);
                    column?.setFilterValue(allValues);
                  }}
                >
                  All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => column?.setFilterValue([])}
                >
                  None
                </Button>
              </div>
              <div className="p-2">
                <div className="relative">
                  <Search className="text-muted-foreground absolute top-1/2 left-3 z-10 h-4 w-4 -translate-y-1/2" />
                  <Input
                    placeholder="Search options..."
                    value={filterSearchValues[filter.id] || ''}
                    onChange={(e) =>
                      setFilterSearchValues((prev) => ({
                        ...prev,
                        [filter.id]: e.target.value,
                      }))
                    }
                    className="pl-9"
                  />
                </div>
              </div>
              {filter.options
                .filter((opt) => {
                  const search = filterSearchValues[filter.id] || '';
                  return opt.label.toLowerCase().includes(search.toLowerCase());
                })
                .map((option) => {
                  const isChecked = filterValues.includes(option.value);
                  return (
                    <div
                      key={option.value}
                      className="hover:bg-accent/10 flex cursor-pointer items-center px-2 py-1.5 text-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isChecked) {
                          column?.setFilterValue(filterValues.filter((v) => v !== option.value));
                        } else {
                          column?.setFilterValue([...filterValues, option.value]);
                        }
                      }}
                    >
                      <Checkbox
                        checked={isChecked}
                        className="mr-2"
                        onCheckedChange={() => {
                          if (isChecked) {
                            column?.setFilterValue(filterValues.filter((v) => v !== option.value));
                          } else {
                            column?.setFilterValue([...filterValues, option.value]);
                          }
                        }}
                      />
                      <span className={filter.lowercase ? '' : 'capitalize'}>
                        {option.label}
                        {option.count !== undefined && (
                          <span className="text-muted-foreground ml-1">({option.count})</span>
                        )}
                      </span>
                    </div>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </>
  );
}

export function DataTableSortHeader({
  column,
  label,
  className,
}: {
  column: Column<any>;
  label: string;
  className?: string;
}) {
  if (!column.getCanSort()) {
    return <div className={cn(className)}>{label}</div>;
  }

  return (
    <div className={cn('flex items-center space-x-2', className)}>
      <Button
        variant="ghost"
        size="sm"
        className="data-[state=open]:bg-accent -ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
      >
        <span>{label}</span>
        {column.getIsSorted() === 'desc' ? (
          <ArrowDown className="ml-2 h-4 w-4" />
        ) : column.getIsSorted() === 'asc' ? (
          <ArrowUp className="ml-2 h-4 w-4" />
        ) : (
          <ArrowUpDown className="ml-2 h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

export const DataTableSelectColumn: ColumnDef<any> = {
  id: 'select',
  header: ({ table }) => (
    <Checkbox
      checked={table.getIsAllPageRowsSelected()}
      onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
      aria-label="Select all"
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(value) => row.toggleSelected(!!value)}
      aria-label="Select row"
    />
  ),
  enableSorting: false,
  enableHiding: false,
};
