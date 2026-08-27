const LAB_TOKEN_KEY = 'lab-api-token';

// the stack's own token, injected by the devenv only under lan.expose (devenv.nix processes.lab-web) so
// a LAN browser is authenticated with no manual step. Read per call, not once at module load, so a test
// (and a browser refresh) sees the current value.
function injectedToken(): string {
  return import.meta.env.VITE_LAB_API_TOKEN?.trim() ?? '';
}

/** The injected token wins: this bundle is served BY the stack it talks to (baseUrl '' → the same-origin
 *  vite proxy), so the stack's own token is authoritative, and a token typed while debugging must not
 *  outlive the problem it was typed for. The stored one is the fallback for a hand-run lab-web (no
 *  injection), incl. one proxied at a different lab. */
export function labApiToken(): string {
  const injected = injectedToken();
  if (injected) return injected;
  try {
    return localStorage.getItem(LAB_TOKEN_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Whether a stored token would be ignored, so the settings card can say so instead of lying. */
export function labTokenIsStackProvided(): boolean {
  return injectedToken() !== '';
}

export function setLabApiToken(token: string): void {
  const trimmed = token.trim();
  try {
    if (trimmed) localStorage.setItem(LAB_TOKEN_KEY, trimmed);
    else localStorage.removeItem(LAB_TOKEN_KEY);
  } catch (error) {
    console.debug('lab token persist failed', error);
  }
}

export function withLabToken(path: string): string {
  const token = labApiToken();
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}
