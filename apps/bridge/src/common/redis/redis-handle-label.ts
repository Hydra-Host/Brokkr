import { isRecord } from '@repo/utils';

// stamped on the ioredis socket so the shutdown handle dump can name which client leaked; without
// it the dump shows several indistinguishable TCP sockets to the same Redis host:port.
const HANDLE_LABEL_KEY = '__brokkrRedisLabel';

export function labelRedisStream(stream: object | null | undefined, label: string): void {
  if (stream === null || stream === undefined) return;
  try {
    // non-enumerable: a labelled socket must still serialize identically anywhere it is inspected.
    Object.defineProperty(stream, HANDLE_LABEL_KEY, {
      value: label,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // a frozen/proxied stream is not worth failing a connect over — the dump just stays unlabelled.
  }
}

export function readHandleLabel(handle: unknown): string | null {
  if (!isRecord(handle)) return null;
  const label = handle[HANDLE_LABEL_KEY];
  return typeof label === 'string' ? label : null;
}
