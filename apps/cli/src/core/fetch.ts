import { getApiUrl, getConnectionMode, getEnvApiKey } from '../config/env.js';
import { getSession } from '../config/store.js';

function resolveAuthHeaders(url: string, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = { Origin: url };

  if (cookie) {
    headers.cookie = cookie;
    return headers;
  }

  const session = getSession();

  if (session?.apiKey) {
    headers['x-api-key'] = session.apiKey;
    return headers;
  }

  if (session?.cookie) {
    headers.cookie = session.cookie;
    return headers;
  }

  const configApiKey = getEnvApiKey();
  if (configApiKey) {
    headers['x-api-key'] = configApiKey;
    return headers;
  }

  throw new Error('Not logged in. Run: brokkr login');
}

export function authedFetch(path: string, baseUrl?: string, cookie?: string): Promise<Response> {
  if (getConnectionMode() === 'bridge') {
    return fetch(path, { credentials: 'include' });
  }

  const url = baseUrl ?? getApiUrl();
  return fetch(`${url}${path}`, { headers: resolveAuthHeaders(url, cookie) });
}

export function authedFetchWithBody(path: string, method: string, body: unknown): Promise<Response> {
  if (getConnectionMode() === 'bridge') {
    return fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  }

  const baseUrl = getApiUrl();
  const headers = resolveAuthHeaders(baseUrl);
  headers['Content-Type'] = 'application/json';

  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}
