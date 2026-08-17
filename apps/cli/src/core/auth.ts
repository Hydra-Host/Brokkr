import { z } from 'zod';
import { authedFetch } from './fetch.js';

export interface LoginResult {
  userId: string;
  email: string;
  cookie: string;
}

export interface TwoFactorRequired {
  twoFactorRequired: true;
  cookie: string;
}

export interface SessionInfo {
  userId: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  activeOrganizationId: string | null;
}

const LoginResponseSchema = z.union([
  z.object({ twoFactorRedirect: z.literal(true) }),
  z.object({ user: z.object({ id: z.string(), email: z.string() }) }),
  z.object({ id: z.string(), email: z.string() }),
]);

const SessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.date()]).nullable().optional(),
  updatedAt: z.union([z.string(), z.date()]).nullable().optional(),
});

const SessionResponseSchema = z.object({
  user: SessionUserSchema.optional(),
  session: z.object({ activeOrganizationId: z.string().nullable().optional() }).optional(),
  id: z.string().optional(),
  email: z.string().optional(),
  name: z.string().nullable().optional(),
  activeOrganizationId: z.string().nullable().optional(),
});

const VerifyApiKeyResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  tenantType: z.string().optional(),
});

const ErrorBodySchema = z.object({ message: z.string().optional() });

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.text();
  try {
    const result = ErrorBodySchema.safeParse(JSON.parse(body));
    if (result.success && result.data.message) return result.data.message;
  } catch (error) {
    void error;
  }
  return fallback;
}

export function extractCookies(response: Response): string[] {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) {
    const raw = response.headers.get('set-cookie');
    if (raw) setCookies.push(...raw.split(/,(?=\s*\w+=)/));
  }
  return setCookies.map((sc) => sc.split(';')[0]!.trim());
}

export function mergeCookies(existing: string, newCookies: string[]): string {
  const cookieMap = new Map<string, string>();
  for (const part of existing.split('; ')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) cookieMap.set(part.slice(0, eqIdx), part);
  }
  for (const nameValue of newCookies) {
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx > 0) cookieMap.set(nameValue.slice(0, eqIdx), nameValue);
  }
  return [...cookieMap.values()].join('; ');
}

export async function login(
  baseUrl: string,
  email: string,
  password: string,
): Promise<LoginResult | TwoFactorRequired> {
  const response = await fetch(`${baseUrl}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });

  if (!response.ok && response.status !== 302) {
    throw new Error(await parseErrorMessage(response, `Login failed (${response.status})`));
  }

  const raw = await response.json();
  const cookie = extractCookies(response).join('; ');
  const parsed = LoginResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error('Unexpected login response. Please try again or contact support.');
  }

  const loginBody = parsed.data;

  if ('twoFactorRedirect' in loginBody) {
    return { twoFactorRequired: true, cookie };
  }

  if ('user' in loginBody) {
    return { userId: loginBody.user.id, email: loginBody.user.email, cookie };
  }

  return { userId: loginBody.id, email: loginBody.email, cookie };
}

export async function verifyTotp(baseUrl: string, code: string, cookie: string): Promise<LoginResult> {
  const response = await fetch(`${baseUrl}/api/v1/auth/two-factor/verify-totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, cookie },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, `2FA verification failed (${response.status})`));
  }

  const newCookies = extractCookies(response);
  const finalCookie = newCookies.length > 0 ? mergeCookies(cookie, newCookies) : cookie;

  const session = await getSession(baseUrl, finalCookie);
  return { userId: session.userId, email: session.email, cookie: finalCookie };
}

export async function getSession(baseUrl?: string, cookie?: string): Promise<SessionInfo> {
  const response = await authedFetch('/api/v1/auth/get-session', baseUrl, cookie);

  if (!response.ok) {
    throw new Error(`Session check failed (${response.status})`);
  }

  const raw = await response.json();
  if (!raw) throw new Error('No active session');

  const parsed = SessionResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('No active session');

  const body = parsed.data;
  const userId = body.user?.id ?? body.id;
  const email = body.user?.email ?? body.email;

  if (!userId || !email) throw new Error('No active session');

  const u = body.user;
  return {
    userId,
    email,
    name: u?.name ?? body.name ?? null,
    firstName: u?.firstName ?? null,
    lastName: u?.lastName ?? null,
    createdAt: u?.createdAt != null ? String(u.createdAt) : null,
    updatedAt: u?.updatedAt != null ? String(u.updatedAt) : null,
    activeOrganizationId: body.session?.activeOrganizationId ?? body.activeOrganizationId ?? null,
  };
}

export async function logout(baseUrl: string, cookie: string): Promise<void> {
  await fetch(`${baseUrl}/api/v1/auth/sign-out`, {
    method: 'POST',
    headers: { cookie, Origin: baseUrl },
  });
}

export function isTwoFactorRequired(result: LoginResult | TwoFactorRequired): result is TwoFactorRequired {
  return 'twoFactorRequired' in result;
}

export interface ApiKeyVerifyResult {
  organizationId: string;
  organizationName: string;
  tenantType: string;
}

export async function verifyApiKey(baseUrl: string, apiKey: string): Promise<ApiKeyVerifyResult> {
  const response = await fetch(`${baseUrl}/api/v1/organizations/active`, {
    headers: { 'x-api-key': apiKey, Origin: baseUrl },
  });

  if (response.status === 401) {
    throw new Error('Invalid API key');
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      `API returned non-JSON response (${response.status}). Check that the API URL is correct: ${baseUrl}`,
    );
  }

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, `API key verification failed (${response.status})`));
  }

  const raw = await response.json();
  const parsed = VerifyApiKeyResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error('Unexpected response from API key verification');
  }

  return {
    organizationId: parsed.data.id,
    organizationName: parsed.data.name,
    tenantType: parsed.data.tenantType ?? 'Unknown',
  };
}
