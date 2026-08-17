import type { ApiFetcherArgs } from '@ts-rest/core';

export async function bridgeApiFetcher(
  args: ApiFetcherArgs,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const headers: Record<string, string> = { ...args.headers };
  delete headers['Content-Type'];
  headers['content-type'] = 'application/json';

  const fetchOptions: RequestInit = {
    method: args.method,
    headers,
    credentials: 'include',
  };

  if (args.body != null && args.method !== 'GET' && args.method !== 'HEAD') {
    fetchOptions.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  }

  const response = await fetch(args.path, fetchOptions);
  const text = await response.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body, headers: response.headers };
}
