// Vite passes bare IPs through its host check, so only names need listing; `true` disables the check outright.
export function devAllowedHosts(): string[] {
  // '.localhost' keeps Vite 7's own default: the leading dot admits every *.localhost subdomain
  const hosts = new Set(['localhost', '.localhost', '127.0.0.1', '::1']);
  const bind = process.env.HOST?.trim();
  if (bind && bind !== '0.0.0.0' && bind !== '::') hosts.add(bind);
  for (const name of (process.env.ALLOWED_HOSTS ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed) hosts.add(trimmed);
  }
  return [...hosts];
}

// The fallback is the bind when HOST is unset: undefined lets vite pick, a literal pins loopback.
export function devBindHost(fallback?: string): string | undefined {
  return process.env.HOST || fallback;
}

// Strict unless the caller named a port, so a chosen port never silently becomes a different one.
export function devStrictPort(): boolean {
  return process.env.VITE_STRICT_PORT === 'true' || !process.env.PORT;
}

// The proxied api resolves the caller from the forwarded headers, so a dev proxy must rewrite Host and append X-Forwarded-*.
export const DEV_PROXY_FORWARDING = { changeOrigin: true, xfwd: true } as const;
