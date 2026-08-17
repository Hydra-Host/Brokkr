import type { Command } from 'commander';

const MAX_PAGE_SIZE = 100;

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface PaginationFlags {
  page: string;
  pageSize: string;
  json: boolean;
  sort?: string;
  search?: string;
  filters?: string;
}

export interface PaginationQuery {
  page: number;
  pageSize: number;
  sort?: string;
  search?: string;
  filters?: string;
}

export function paginationOptions(cmd: Command): Command {
  return cmd
    .option('--page <number>', 'Page number', '1')
    .option('--page-size <number>', 'Items per page (max 100)', '20')
    .option('--json', 'Output as JSON', false);
}

export function sortOption(cmd: Command): Command {
  return cmd.option('--sort <expr>', 'Sort expression: "field:asc|desc,field:asc|desc".');
}

export function searchOption(cmd: Command): Command {
  return cmd.option('--search <query>', 'Free-text search, max 200 chars.');
}

export function filtersOption(cmd: Command): Command {
  return cmd.option('--filters <expr>', 'Filter expression: "field:op:value|field:op:value".');
}

export const FILTER_GRAMMAR_HELP = `Filter grammar:
  --filters "field:op:value|field:op:value"    Pipe-delimited (AND across fields)
  Operators: eq, neq, gt, gte, lt, lte, contains
Sort grammar:
  --sort "field:dir,field:dir"                 dir is "asc" (default) or "desc".
Search grammar:
  --search "text"                              Free text, max 200 chars, case-insensitive.`;

export function buildQuery(flags: PaginationFlags): PaginationQuery {
  const page = parseInt(flags.page, 10);
  const pageSize = parseInt(flags.pageSize, 10);
  return {
    page: Number.isNaN(page) || page < 1 ? 1 : page,
    pageSize: Number.isNaN(pageSize) || pageSize < 1 ? 20 : Math.min(pageSize, MAX_PAGE_SIZE),
    ...(flags.sort ? { sort: flags.sort } : {}),
    ...(flags.search ? { search: flags.search.slice(0, 200) } : {}),
    ...(flags.filters ? { filters: flags.filters } : {}),
  };
}

export function paginationFooter(meta: PaginationMeta | undefined, nextCommand: string): string | undefined {
  if (!meta) return undefined;
  if (meta.totalPages <= 1) return `${meta.totalItems} total`;
  if (meta.page >= meta.totalPages) return `Page ${meta.page}/${meta.totalPages} (${meta.totalItems} total)`;
  return `Page ${meta.page}/${meta.totalPages} (${meta.totalItems} total) — next: ${nextCommand} --page ${meta.page + 1}`;
}
