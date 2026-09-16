import { createHash } from 'node:crypto';

const LOCAL_NS = '5d4e0c4a-1f7c-4f4e-9c4e-1d8d2a3b4c5d';

/** Deterministic hub Device.id for the sim node at `index` — must match the ids sim:seed creates in the hub. */
export function simDeviceUuid(index: number): string {
  return `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
}

export function simDeviceIndex(id: string): number | null {
  const m = /^00000000-0000-0000-0000-(\d{12})$/.exec(id);
  if (!m) return null;
  const index = parseInt(m[1], 10) - 1;
  return index >= 0 ? index : null;
}

/** Deterministic hub Device.id for a bare-metal machine — uuid5(LOCAL_NS, "baremetal:<pxe mac>"),
 *  the same derivation local-sim's bare-metal seed uses. */
export function bmDeviceUuid(mac: string): string {
  const nsBytes = Buffer.from(LOCAL_NS.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(`baremetal:${mac.toLowerCase()}`, 'utf8'))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SIM_ADMIN_EMAIL = 'brokkr@brokkr.local';
const SIM_ADMIN_PASSWORD = 'brokkr';
const SIM_ORG_ID = '00000000-0000-0000-0000-000000000000';

export async function hubApiFetch(
  hubBase: string,
  jar: Map<string, string>,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ code: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${hubBase}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal,
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const h of sc) {
    const m = h.match(/^([^=]+)=([^;]*)/);
    if (m) jar.set(m[1], m[2]);
  }
  const text = await res.text();
  return { code: res.status, body: text ? JSON.parse(text) : null };
}

export async function hubApiSignIn(hubBase: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const signIn = await hubApiFetch(
    hubBase,
    jar,
    'POST',
    '/api/v1/auth/sign-in/email',
    { email: SIM_ADMIN_EMAIL, password: SIM_ADMIN_PASSWORD },
    signal,
  );
  if (signIn.code !== 200) throw new Error(`sign-in failed (${signIn.code}): ${JSON.stringify(signIn.body)}`);
  const setOrg = await hubApiFetch(hubBase, jar, 'POST', `/api/v1/organizations/${SIM_ORG_ID}/set-active`, {}, signal);
  if (setOrg.code !== 200) throw new Error(`set-active-org failed (${setOrg.code}): ${JSON.stringify(setOrg.body)}`);
  return jar;
}
