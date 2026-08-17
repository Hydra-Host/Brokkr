import { IDENTIFIER_KINDS } from '../device-record/identifier-kinds';

// job_id from unauthenticated /api/chain renders unescaped into the iPXE script; a newline could inject script lines. Non-conforming values drop to '' (treated as "none").
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9._:-]*$/;

export function sanitizeChainJobId(jobId: string): string {
  return SAFE_JOB_ID_PATTERN.test(jobId) ? jobId : '';
}

export function extractIdentifiers(body: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (body == null || typeof body !== 'object') return result;
  const bag = body as Record<string, unknown>;
  for (const kind of IDENTIFIER_KINDS) {
    const value = bag[kind];
    if (value) {
      result[kind] = value as string;
    }
  }
  return result;
}
