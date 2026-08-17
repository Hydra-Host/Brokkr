export const BYPASS_MIN_PASSWORD_LENGTH = 6;

export interface AuthBypassPolicy {
  enabled: boolean;
  autoResolveAdminOwner: boolean;
  skipEntraLink: boolean;
  relaxOrigins: boolean;
  relaxPasswordPolicy: boolean;
  relaxRateLimit: boolean;
  seedBypassUser: boolean;
}

function allowedEnvs(env: NodeJS.ProcessEnv): string[] {
  return (env.AUTH_BYPASS_ALLOWED_ENVS ?? 'dev')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isEnvPermitted(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== 'production' && allowedEnvs(env).includes(env.HH_ENV ?? '');
}

function isAuthBypassRequested(env: NodeJS.ProcessEnv): boolean {
  return env.AUTH_BYPASS_ENABLED === 'true' || env.LOCAL_SIMULATION_ENABLED === 'true';
}

export function resolveAuthBypassPolicy(env: NodeJS.ProcessEnv = process.env): AuthBypassPolicy {
  const enabled = isAuthBypassRequested(env) && isEnvPermitted(env);
  return {
    enabled,
    autoResolveAdminOwner: enabled,
    skipEntraLink: enabled,
    relaxOrigins: enabled,
    relaxPasswordPolicy: enabled,
    relaxRateLimit: enabled,
    seedBypassUser: enabled,
  };
}

export function isLocalSimulationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOCAL_SIMULATION_ENABLED === 'true' && isEnvPermitted(env);
}

// Turns a silent misconfig into a boot crash; the gates above already make the flag inert.
export function assertAuthBypassEnvSafe(env: NodeJS.ProcessEnv = process.env): void {
  if (!isAuthBypassRequested(env) || isEnvPermitted(env)) return;
  throw new Error(
    `AUTH_BYPASS_ENABLED/LOCAL_SIMULATION_ENABLED is only allowed when NODE_ENV!=="production" and ` +
      `HH_ENV is in AUTH_BYPASS_ALLOWED_ENVS [${allowedEnvs(env).join(', ')}] ` +
      `(got HH_ENV=${env.HH_ENV ?? 'unset'}, NODE_ENV=${env.NODE_ENV ?? 'unset'}). ` +
      `These flags unlock auth/CSRF/MFA bypasses unsafe outside dev/CI — refusing to start.`,
  );
}

export function describeAuthBypass(policy: AuthBypassPolicy): string[] {
  if (!policy.enabled) return [];
  return [
    'AUTH BYPASS ACTIVE — the following security controls are relaxed:',
    policy.autoResolveAdminOwner ? '  • admin SSO bypassed (auto-resolves seeded Owner)' : '',
    policy.skipEntraLink ? '  • Microsoft Entra account-link requirement skipped' : '',
    policy.relaxOrigins ? '  • CSRF disabled + all origins trusted' : '',
    policy.relaxPasswordPolicy ? `  • minimum password length lowered to ${BYPASS_MIN_PASSWORD_LENGTH}` : '',
    policy.relaxRateLimit ? '  • auth rate limiter disabled' : '',
    policy.seedBypassUser ? '  • local BoSS test identities + organizations seeded' : '',
  ].filter(Boolean);
}
