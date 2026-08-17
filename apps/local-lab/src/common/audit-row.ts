import { isRecord } from '@repo/utils';

import { serializeAuditParams } from './redact';

/** The request surface an audit row is built from — the guard and the interceptor share it. */
export interface AuditRequest {
  method: string;
  path: string;
  body?: unknown;
  params?: unknown;
  query?: unknown;
}

// express routes HEAD to the matching GET handler, so auditing it would let an uptime probe evict
// every real row from the capped table
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export function auditParams(req: AuditRequest): string | null {
  return serializeAuditParams({
    ...(isRecord(req.body) ? req.body : {}),
    ...(isRecord(req.params) ? req.params : {}),
    ...(isRecord(req.query) ? req.query : {}),
  });
}
