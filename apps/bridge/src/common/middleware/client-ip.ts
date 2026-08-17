// `remoteAddr` (Fastify `req.ip`, trustProxy-aware) is the only non-spoofable source and takes precedence; the forwarding headers are attacker-controlled, last-resort only.

export type ClientIpHeaders = Readonly<Record<string, string | string[] | undefined>>;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function extractClientIp(headers: ClientIpHeaders, remoteAddr: string | null | undefined): string {
  const remote = remoteAddr?.trim();
  if (remote) return remote;

  const forwardedFor = headerValue(headers['X-Forwarded-For']);
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = headerValue(headers['X-Real-IP']);
  if (realIp) return realIp.trim();

  const cfIp = headerValue(headers['CF-Connecting-IP']);
  if (cfIp) return cfIp.trim();

  const forwardedHost = headerValue(headers['X-Forwarded-Host']);
  if (forwardedHost) return forwardedHost.trim();

  return 'unknown';
}

const CANONICAL_PROXY_HEADERS: ReadonlyArray<string> = [
  'X-Forwarded-For',
  'X-Real-IP',
  'CF-Connecting-IP',
  'X-Forwarded-Host',
];

export function extractClientIpFromRequest(headers: ClientIpHeaders, remoteAddr: string | null | undefined): string {
  const lookup: Record<string, string | string[] | undefined> = {};
  for (const k of Object.keys(headers)) lookup[k.toLowerCase()] = headers[k];
  const canonical: Record<string, string | undefined> = {};
  for (const name of CANONICAL_PROXY_HEADERS) {
    const raw = lookup[name.toLowerCase()];
    if (Array.isArray(raw)) canonical[name] = raw.join(', ');
    else if (raw !== undefined) canonical[name] = raw;
  }
  return extractClientIp(canonical, remoteAddr);
}
