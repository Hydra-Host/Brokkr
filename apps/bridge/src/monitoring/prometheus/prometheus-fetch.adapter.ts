import type { PrometheusFetcher } from './prometheus.service';

export function createGlobalFetchPrometheusFetcher(fetchImpl: typeof fetch = globalThis.fetch): PrometheusFetcher {
  return {
    async get(url: string, timeoutSeconds: number) {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      return {
        status: response.status,
        text: () => response.text(),
      };
    },
    async post(url: string, body: Uint8Array, headers: Record<string, string>, timeoutSeconds: number) {
      const bodyBuffer = new Uint8Array(body.byteLength);
      bodyBuffer.set(body);
      const response = await fetchImpl(url, {
        method: 'POST',
        body: bodyBuffer,
        headers,
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      return {
        status: response.status,
        text: () => response.text(),
      };
    },
  };
}
