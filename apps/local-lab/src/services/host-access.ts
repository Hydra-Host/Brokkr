import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HostAccessSchema, type HostAccess } from '@repo/local-lab-contract';

export function hostAccessPath(): string | null {
  const state = process.env.DEVENV_STATE;
  return state ? join(state, 'host-access.json') : null;
}

// every failure path yields undefined: a missing or corrupt marker must never fail /api/status, and
// a stack that has not run the check yet is indistinguishable from one whose marker was wiped.
export function readHostAccess(): HostAccess | undefined {
  const path = hostAccessPath();
  if (!path) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // a not-yet-written marker is the normal cold state; anything else is worth a trace, because
    // all four failure modes render identically as an absent hostAccess field.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.debug('[host-access] read failed', code, path);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.debug('[host-access] marker is not valid json', path);
    return undefined;
  }
  const result = HostAccessSchema.safeParse(parsed);
  if (!result.success) {
    console.debug('[host-access] marker failed schema validation', result.error.issues);
    return undefined;
  }
  // the shell writer emits `date +%s`; every other timestamp in StatusSchema is unix ms.
  return { ...result.data, checkedAt: result.data.checkedAt * 1000 };
}
