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

const SIM_ADMIN_EMAIL = 'brokkr@brokkr.local';
const SIM_ADMIN_PASSWORD = 'brokkr';
const SIM_ORG_ID = '00000000-0000-0000-0000-000000000000';

export async function hubApiFetch(
  hubBase: string,
  jar: Map<string, string>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ code: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${hubBase}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const h of sc) {
    const m = h.match(/^([^=]+)=([^;]*)/);
    if (m) jar.set(m[1], m[2]);
  }
  const text = await res.text();
  return { code: res.status, body: text ? JSON.parse(text) : null };
}

export async function hubApiSignIn(hubBase: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const signIn = await hubApiFetch(hubBase, jar, 'POST', '/api/v1/auth/sign-in/email', {
    email: SIM_ADMIN_EMAIL,
    password: SIM_ADMIN_PASSWORD,
  });
  if (signIn.code !== 200) throw new Error(`sign-in failed (${signIn.code}): ${JSON.stringify(signIn.body)}`);
  const setOrg = await hubApiFetch(hubBase, jar, 'POST', `/api/v1/organizations/${SIM_ORG_ID}/set-active`, {});
  if (setOrg.code !== 200) throw new Error(`set-active-org failed (${setOrg.code}): ${JSON.stringify(setOrg.body)}`);
  return jar;
}
