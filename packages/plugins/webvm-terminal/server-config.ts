// Cross-origin-isolation policy shared by the Vite dev and Express prod middleware so dev and prod can't drift — a mismatch would silently fail isolation in one.

/** The document must be served at exactly these paths (with and without .html / trailing slash). */
export const WEBVM_TERMINAL_PATHS = ['/webvm-terminal', '/webvm-terminal/', '/webvm-terminal.html'] as const;

/** The actual HTML file the non-.html paths rewrite to. */
export const WEBVM_TERMINAL_HTML = '/webvm-terminal.html';

// COEP must NOT be app-wide — it breaks embedded third-party iframes (e.g. Stripe
// Elements) — so it applies only to WEBVM_TERMINAL_PATHS.
export const WEBVM_TERMINAL_COEP_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'credentialless',
} as const;

// Full isolation policy (COOP + COEP) for hosts with no app-wide COOP baseline
// (e.g. the Vite dev server); hosts with COOP apply WEBVM_TERMINAL_COEP_HEADERS.
export const WEBVM_TERMINAL_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  ...WEBVM_TERMINAL_COEP_HEADERS,
} as const;

/** Whether a request pathname is one the isolation headers + rewrite apply to. */
export function isWebvmTerminalPath(pathname: string): pathname is (typeof WEBVM_TERMINAL_PATHS)[number] {
  return WEBVM_TERMINAL_PATHS.some((path) => path === pathname);
}
