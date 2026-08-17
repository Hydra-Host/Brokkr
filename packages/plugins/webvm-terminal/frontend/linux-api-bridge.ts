// Bridge protocol markers — null-delimited JSON payloads in VM stdout/stdin.
// BROKKR_CMD runs the full CLI in the browser; BROKKR_REQ makes a single API call.
export const REQUEST_START = '\x00BROKKR_REQ:';
export const REQUEST_END = '\x00';
export const COMMAND_START = '\x00BROKKR_CMD:';
export const COMMAND_END = '\x00';
export const RESPONSE_START = '\x00BROKKR_RES:';
export const RESPONSE_END = '\x00';

export function normalizeApiPath(url: string): string {
  const raw = url.startsWith('/') ? url : '/' + url;
  // Resolve '.'/'..' BEFORE the prefix checks: fetch() resolves dot segments after the prefix is
  // prepended, so '../../admin' would escape /api/v1; the throwaway base neutralizes '//host/x' too.
  const resolved = new URL(raw, 'https://bridge.invalid');
  let path = resolved.pathname;
  if (path === '/api/v1' || path.startsWith('/api/v1/')) {
    // already correct
  } else if (path.startsWith('/api/')) {
    path = '/api/v1' + path.slice(4);
  } else {
    path = '/api/v1' + path;
  }
  return path + resolved.search;
}

export async function makeApiRequest(requestJson: string): Promise<{ status: number; body: string }> {
  try {
    const { method, url, body, headers: reqHeaders } = JSON.parse(requestJson);
    const apiPath = normalizeApiPath(url);

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...(reqHeaders && typeof reqHeaders === 'object' ? reqHeaders : {}),
      },
      credentials: 'include',
    };

    if (body && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(apiPath, fetchOptions);
    const responseText = await response.text();
    return { status: response.status, body: responseText };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

export function formatApiOutput(status: number, body: string): string {
  const isSuccess = status >= 200 && status < 300;
  const color = isSuccess ? '\x1b[32m' : '\x1b[31m';
  const icon = isSuccess ? '\u2713' : '\u2717';

  let formatted = body;
  try {
    formatted = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    formatted = body;
  }

  return `${color}${icon} HTTP ${status}\x1b[0m\n\n${formatted}\n`;
}
