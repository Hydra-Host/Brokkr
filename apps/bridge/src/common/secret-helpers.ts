import { syncLogInfo, syncLogWarning } from '../logger/sync-log';

export function warnPartialEnv(slug: string, envState: Readonly<Record<string, string | null | undefined>>): void {
  const present: string[] = [];
  const missing: string[] = [];
  for (const [name, value] of Object.entries(envState)) {
    if (value) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }
  if (present.length > 0 && missing.length > 0) {
    syncLogWarning(
      `Partial env detected for slug '${slug}': have ${JSON.stringify(present)}, missing ${JSON.stringify(missing)} (set all or unset all)`,
    );
  }
}

export interface ResolveEnvSecretOptions<T> {
  slug: string;
  envLoader: () => T | null;
  required: boolean;
}

export function resolveEnvSecret<T>(opts: ResolveEnvSecretOptions<T>): T | null {
  const payload = opts.envLoader();
  if (payload !== null) {
    syncLogInfo(`Loaded slug '${opts.slug}' from environment`);
    return payload;
  }
  if (opts.required) {
    throw new Error(`Required env vars for slug '${opts.slug}' are missing`);
  }
  syncLogInfo(`Env vars for optional slug '${opts.slug}' not set; returning None`);
  return null;
}
