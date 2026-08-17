import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export interface ApiCall {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus?: number;
  responseStatusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  duration?: number;
  error?: string;
}

interface ApiMonitorContextValue {
  calls: ApiCall[];
  clear: () => void;
}

const MAX_CALLS = 50;

const IGNORED_EXTENSIONS = new Set(['.js', '.css', '.map', '.ico', '.png', '.svg', '.jpg', '.woff', '.woff2', '.ttf']);

const BODY_PARSERS: Record<string, (cloned: Response) => Promise<unknown>> = {
  'application/json': (r) => r.json(),
  'text/': async (r) => {
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  },
};

function extractPath(url: string): string {
  try {
    return url.startsWith('/') ? url.split('?')[0] : new URL(url).pathname;
  } catch {
    return url;
  }
}

function shouldCapture(url: string, method: string): boolean {
  const ext = url.match(/\.\w+(?:\?|$)/)?.[0]?.replace('?', '');
  if (ext && IGNORED_EXTENSIONS.has(ext)) return false;
  if (url.includes('/assets/')) return false;

  const path = extractPath(url);
  if (path.startsWith('/api/')) return true;
  if (path.startsWith('/__')) return false;
  return method !== 'GET';
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (!body) return null;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof FormData) {
    return Object.fromEntries([...body.entries()].map(([k, v]) => [k, v instanceof File ? `[File: ${v.name}]` : v]));
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  return '[Binary data]';
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const parser = Object.entries(BODY_PARSERS).find(([key]) => contentType.includes(key));
  if (!parser) return null;
  try {
    return await parser[1](response.clone());
  } catch {
    return null;
  }
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const raw = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  return raw.toUpperCase();
}

export const ApiMonitorContext = createContext<ApiMonitorContextValue | null>(null);

export function useApiMonitorProvider() {
  const [calls, setCalls] = useState<ApiCall[]>([]);
  const originalFetchRef = useRef<typeof fetch | null>(null);
  const interceptedRef = useRef(false);

  const clear = useCallback(() => setCalls([]), []);

  const pushCall = useCallback((call: ApiCall) => {
    setCalls((prev) => [call, ...prev].slice(0, MAX_CALLS));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || interceptedRef.current) return;

    interceptedRef.current = true;
    originalFetchRef.current = window.fetch.bind(window);
    const originalFetch = originalFetchRef.current;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = resolveUrl(input);
      const method = resolveMethod(input, init);

      if (!shouldCapture(url, method)) return originalFetch(input, init);

      const startTime = Date.now();
      const baseCall: ApiCall = {
        id: Math.random().toString(36).slice(2, 11),
        timestamp: startTime,
        method,
        url,
        path: extractPath(url),
        requestHeaders: headersToRecord(init?.headers),
        requestBody: parseBody(init?.body),
      };

      try {
        const response = await originalFetch(input, init);

        pushCall({
          ...baseCall,
          responseStatus: response.status,
          responseStatusText: response.statusText,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseBody: await parseResponseBody(response),
          duration: Date.now() - startTime,
        });

        return response;
      } catch (error) {
        pushCall({
          ...baseCall,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        });
        throw error;
      }
    };

    return () => {
      if (originalFetchRef.current) {
        window.fetch = originalFetchRef.current;
        interceptedRef.current = false;
      }
    };
  }, [pushCall]);

  return { calls, clear };
}

export function useApiMonitor(): ApiMonitorContextValue {
  return useContext(ApiMonitorContext) ?? { calls: [], clear: () => {} };
}
