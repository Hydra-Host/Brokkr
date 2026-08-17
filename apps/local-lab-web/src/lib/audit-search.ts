import type { AuditEvent, AuditOutcome } from '@/contract';

export type AuditMethod = 'POST' | 'PUT' | 'DELETE' | 'WS';

export interface AuditSearch {
  outcome: AuditOutcome | undefined;
  method: AuditMethod | undefined;
  q: string | undefined;
  page: number | undefined;
}

// annotated, not inferred: a new contract outcome must widen the filter deliberately rather than by being listed here
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['ok', 'error', 'denied'];
// what the table can hold, not what the contract serves: reads are never recorded, and an upgrade logs 'WS'
export const AUDIT_METHODS: readonly AuditMethod[] = ['POST', 'PUT', 'DELETE', 'WS'];

export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return AUDIT_OUTCOMES.some((id) => id === value);
}

export function isAuditMethod(value: unknown): value is AuditMethod {
  return AUDIT_METHODS.some((id) => id === value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pageIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function recordedMethod(value: unknown): AuditMethod | undefined {
  const upper = typeof value === 'string' ? value.toUpperCase() : value;
  return isAuditMethod(upper) ? upper : undefined;
}

export function validateAuditSearch(search: Record<string, unknown>): AuditSearch {
  return {
    outcome: isAuditOutcome(search.outcome) ? search.outcome : undefined,
    method: recordedMethod(search.method),
    q: text(search.q),
    page: pageIndex(search.page),
  };
}

// the endpoint has no text filter, so q narrows the fetched page only — never the whole log
export function matchesAuditQuery(event: Pick<AuditEvent, 'path' | 'handler'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return event.path.toLowerCase().includes(needle) || event.handler.toLowerCase().includes(needle);
}
