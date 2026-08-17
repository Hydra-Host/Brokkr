import { isRecord } from '@repo/utils';

const REDACTED_LIFECYCLE_FIELDS = ['user_data', 'pubkeys', 'password_hash', 'server_token'] as const;

export function redactPayloadForLog(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  const redacted: Record<string, unknown> = { ...payload };
  const lifecycle = redacted.lifecycle_data;
  if (isRecord(lifecycle)) {
    const redLc: Record<string, unknown> = { ...lifecycle };
    for (const field of REDACTED_LIFECYCLE_FIELDS) {
      if (field in redLc) {
        const value = redLc[field];
        if (Array.isArray(value)) {
          redLc[field] = `<redacted: ${value.length} items>`;
        } else {
          redLc[field] = '<redacted>';
        }
      }
    }
    redacted.lifecycle_data = redLc;
  }
  return redacted;
}
