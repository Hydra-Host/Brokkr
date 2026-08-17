import type { PaginationMeta } from '@repo/api-client';
import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { getErrorMessage } from './format.js';

export type { PaginationMeta };

const MAX_PAGE_SIZE = 100;

export interface PaginationQuery {
  page: number;
  pageSize: number;
  sort?: string;
  search?: string;
  filters?: string;
}

export interface PaginationFlags {
  page: string;
  pageSize: string;
  json: boolean;
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
  return cmd.option('--sort <expr>', 'Sort expression: "field:asc|desc,field:asc|desc". Sortable fields listed below.');
}

export function searchOption(cmd: Command): Command {
  return cmd.option('--search <query>', 'Free-text search, max 200 chars. Searchable fields listed below.');
}

export function filtersOption(cmd: Command): Command {
  return cmd.option(
    '--filters <expr>',
    'Filter expression: "field:op:value|field:op:value". Filterable fields listed below.',
  );
}

export const FILTER_GRAMMAR_HELP = `Filter grammar:
  --filters "field:op:value|field:op:value"    Pipe-delimited (AND across fields)
  Operators: eq, neq, gt, gte, lt, lte, contains
  String eq/neq/contains are case-insensitive. Numbers and dates coerce automatically.
  Repeating the same field with eq OR-combines the values (e.g. "role:eq:A|role:eq:B").
  Unknown fields and invalid values are silently dropped by the API.

Sort grammar:
  --sort "field:dir,field:dir"                 Comma-delimited; dir is "asc" (default) or "desc".
  Unknown fields are dropped; if nothing valid remains the resource default is used.

Search grammar:
  --search "text"                              Free text, max 200 chars, case-insensitive substring.
  Matches if the text appears in any of the resource's searchable fields.`;

export function renderJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

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

export async function fetchPage<T>(
  fetcher: (query: PaginationQuery) => Promise<{
    data: T[];
    meta: PaginationMeta;
  }>,
  flags: PaginationFlags,
): Promise<{ data: T[]; meta: PaginationMeta }> {
  return fetcher(buildQuery(flags));
}

export function paginationFooter(meta: PaginationMeta | undefined, nextCommand: string): string | undefined {
  if (!meta) return undefined;
  if (meta.totalPages <= 1) return `${meta.totalItems} total`;
  return `Page ${meta.page}/${meta.totalPages} (${meta.totalItems} total) — next: ${nextCommand} --page ${meta.page + 1}`;
}

export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  opts?: { onError?: (err: unknown) => never | void; quietFail?: boolean },
): Promise<T> {
  const spinner = ora(message).start();
  try {
    const result = await fn();
    spinner.stop();
    return result;
  } catch (err) {
    if (opts?.quietFail) {
      spinner.stop();
    } else {
      spinner.fail(chalk.red(getErrorMessage(err)));
    }
    if (opts?.onError) {
      opts.onError(err);
    }
    process.exit(1);
  }
}
