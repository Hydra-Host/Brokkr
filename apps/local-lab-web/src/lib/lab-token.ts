const LAB_TOKEN_KEY = 'lab-api-token';
const HOST_TOKEN_KEY = 'lab-host-token';

// injected by the devenv only under lan.expose (devenv.nix processes.lab-web), so a LAN browser needs no
// manual step. Read per call, not at module load, so a refresh (and a test) sees the current value.
function injectedToken(): string {
  return import.meta.env.VITE_LAB_API_TOKEN?.trim() ?? '';
}

function readKey(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function writeKey(key: string, token: string): void {
  const trimmed = token.trim();
  try {
    if (trimmed) localStorage.setItem(key, trimmed);
    else localStorage.removeItem(key);
  } catch (error) {
    console.debug('lab token persist failed', error);
  }
}

/** The injected token wins: this bundle is served BY the stack it talks to, so a token typed while
 *  debugging must not outlive it. The stored one is the fallback for a hand-run lab-web. */
export function labApiToken(): string {
  return injectedToken() || readKey(LAB_TOKEN_KEY);
}

/** Whether a stored token would be ignored, so the settings card can say so instead of lying. */
export function labTokenIsStackProvided(): boolean {
  return injectedToken() !== '';
}

export function setLabApiToken(token: string): void {
  writeKey(LAB_TOKEN_KEY, token);
}

/** Kept under its own key so it never rides an ordinary call: a token that reaches a root-equivalent
 *  route is offered deliberately, on the surface it was typed for. */
export function hostToken(): string {
  return readKey(HOST_TOKEN_KEY);
}

export function setHostToken(token: string): void {
  writeKey(HOST_TOKEN_KEY, token);
}

/** Precedence inverts here, and only here: the injected token's ceiling stops below `host-exec`, so
 *  letting it win would shadow the typed one and refuse forever. */
export function hostExecToken(): string {
  return hostToken() || labApiToken();
}

/** A stack-served bundle is off loopback holding an `admin`-ceiling token, which no host-exec route
 *  accepts — so prompt before the first call rather than after its refusal. */
export function hostTokenNeeded(): boolean {
  return labTokenIsStackProvided() && hostToken() === '';
}

export function withLabToken(path: string): string {
  const token = labApiToken();
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}
