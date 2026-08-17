import { DEFAULT_LOG_SUPPRESS_JOB_ID_PREFIXES } from './logging-context.constants';

export function parseSuppressJobIdPrefixes(raw: string | undefined | null): string[] {
  if (raw == null) return [...DEFAULT_LOG_SUPPRESS_JOB_ID_PREFIXES];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
