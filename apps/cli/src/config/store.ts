import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureConfigDir, getActiveEnv, getConfigDir } from './env.js';

interface StoredSession {
  cookie: string;
  apiKey?: string;
  email: string;
  userId: string;
  environment: string;
  storedAt: string;
}

export interface StoredOrg {
  id: string;
  name: string;
  tenantType: string;
  role?: string;
}

function sessionPath(): string {
  return join(getConfigDir(), `session-${getActiveEnv()}.json`);
}

function orgPath(): string {
  return join(getConfigDir(), `org-${getActiveEnv()}.json`);
}

let cachedSession: StoredSession | null | undefined;
let cachedOrg: StoredOrg | null | undefined;

export function getSession(): StoredSession | null {
  if (cachedSession !== undefined) return cachedSession;
  const path = sessionPath();
  if (!existsSync(path)) {
    cachedSession = null;
    return null;
  }
  try {
    cachedSession = JSON.parse(readFileSync(path, 'utf-8')) as StoredSession;
    return cachedSession;
  } catch {
    cachedSession = null;
    return null;
  }
}

export function saveSession(session: Omit<StoredSession, 'storedAt' | 'environment'>): void {
  const data: StoredSession = {
    ...session,
    environment: getActiveEnv(),
    storedAt: new Date().toISOString(),
  };
  ensureConfigDir();
  writeFileSync(sessionPath(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, encoding: 'utf-8' });
  cachedSession = data;
}

export function clearSession(): void {
  const path = sessionPath();
  if (existsSync(path)) unlinkSync(path);
  const org = orgPath();
  if (existsSync(org)) unlinkSync(org);
  cachedSession = null;
  cachedOrg = null;
}

export function requireSession(): StoredSession {
  const session = getSession();
  if (!session) {
    throw new Error('Not logged in. Run: brokkr login');
  }
  return session;
}

export function isApiKeySession(session?: StoredSession | null): boolean {
  return !!session?.apiKey;
}

export function getActiveOrg(): StoredOrg | null {
  if (cachedOrg !== undefined) return cachedOrg;
  const path = orgPath();
  if (!existsSync(path)) {
    cachedOrg = null;
    return null;
  }
  try {
    cachedOrg = JSON.parse(readFileSync(path, 'utf-8')) as StoredOrg;
    return cachedOrg;
  } catch {
    cachedOrg = null;
    return null;
  }
}

export function saveActiveOrg(org: StoredOrg): void {
  ensureConfigDir();
  writeFileSync(orgPath(), JSON.stringify(org, null, 2) + '\n', { mode: 0o600, encoding: 'utf-8' });
  cachedOrg = org;
}

export function requireActiveOrg(): StoredOrg {
  const org = getActiveOrg();
  if (!org) {
    throw new Error('No organization selected. Run: brokkr org select');
  }
  return org;
}

/** Long-running processes (MCP) must re-read between tool calls so external login/logout/org-select is reflected. */
export function invalidateSessionCaches(): void {
  cachedSession = undefined;
  cachedOrg = undefined;
}
