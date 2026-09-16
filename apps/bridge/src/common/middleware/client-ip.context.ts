import { AsyncLocalStorage } from 'node:async_hooks';

interface ClientIpContextStore {
  clientIp: string;
}

const storage = new AsyncLocalStorage<ClientIpContextStore>();

// The booting node's request source IP, ambient for its HTTP request — lets bridge-IP resolution
// pick the leg on the device's own subnet (parity with the Python bridge's live-request read).
export function getRequestClientIp(): string | null {
  const ip = storage.getStore()?.clientIp;
  return ip !== undefined && ip !== '' && ip !== 'unknown' ? ip : null;
}

export function runWithClientIp<T>(clientIp: string, fn: () => T): T {
  return storage.run({ clientIp }, fn);
}
