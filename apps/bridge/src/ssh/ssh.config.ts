import { z } from 'zod';

import { getBrokkrEnv, isLocalSimulationEnabled } from '../redfish/redfish.config.js';

export class SSHConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSHConfigError';
  }
}

export interface SSHConfig {
  defaultUsername: string;
  defaultPort: number;
  defaultTimeout: number;
  defaultKeyPath: string;
  sshConfigPath: string;
  strictHostKeyChecking: boolean;
  knownHostsPath: string;
  commandTimeout: number;
  scpTimeout: number;
}

export function resolveBridgeSshPrivkeyPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SSH_KEY_PATH || env.BRIDGE_SSH_PRIVKEY_PATH || null;
}

function parseIntStrict(varName: string, raw: string): number {
  const stripped = raw.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(stripped)) {
    throw new Error(`invalid integer: ${JSON.stringify(raw)} (env ${varName})`);
  }
  return Number.parseInt(stripped.replace(/_/g, ''), 10);
}

const sshEnvSchema = z.object({
  SSH_USERNAME: z.string().default('root'),
  SSH_PORT: z
    .string()
    .default('22')
    .transform((v) => parseIntStrict('SSH_PORT', v)),
  SSH_TIMEOUT: z
    .string()
    .default('30')
    .transform((v) => parseIntStrict('SSH_TIMEOUT', v)),
  SSH_CONFIG_PATH: z.string().default(''),
  SSH_STRICT_HOST_KEY_CHECKING: z
    .string()
    .default('true')
    .transform((v) => v.trim().toLowerCase() !== 'false'),
  SSH_KNOWN_HOSTS_PATH: z.string().default(''),
});

// Environments where disabling host-key verification is tolerated; anywhere else it reopens a MITM hole.
const STRICT_HOST_KEY_OPTIONAL_ENVIRONMENTS: ReadonlySet<string> = new Set(['local', 'dev']);

function validateStrictHostKeyChecking(strict: boolean, env: NodeJS.ProcessEnv): void {
  if (strict) return;
  const environment = (getBrokkrEnv(env) || 'prod').trim().toLowerCase();
  if (isLocalSimulationEnabled(env) || STRICT_HOST_KEY_OPTIONAL_ENVIRONMENTS.has(environment)) return;
  throw new SSHConfigError(
    `SSH_STRICT_HOST_KEY_CHECKING=false is only permitted when LOCAL_SIMULATION_ENABLED=true or the resolved ` +
      `environment (BROKKR_ENV ?? HH_ENV ?? ENVIRONMENT) is one of ` +
      `${Array.from(STRICT_HOST_KEY_OPTIONAL_ENVIRONMENTS).join('/')}; refusing to disable SSH host-key verification ` +
      `(environment='${environment}', localSimulation=${isLocalSimulationEnabled(env)})`,
  );
}

export function loadSshConfig(env: NodeJS.ProcessEnv = process.env): SSHConfig {
  const parsed = sshEnvSchema.parse(env);
  validateStrictHostKeyChecking(parsed.SSH_STRICT_HOST_KEY_CHECKING, env);
  return {
    defaultUsername: parsed.SSH_USERNAME,
    defaultPort: parsed.SSH_PORT,
    defaultTimeout: parsed.SSH_TIMEOUT,
    defaultKeyPath: resolveBridgeSshPrivkeyPath(env) ?? '/privkey',
    sshConfigPath: parsed.SSH_CONFIG_PATH,
    strictHostKeyChecking: parsed.SSH_STRICT_HOST_KEY_CHECKING,
    knownHostsPath: parsed.SSH_KNOWN_HOSTS_PATH,
    commandTimeout: 300,
    scpTimeout: 300,
  };
}

let cached: SSHConfig | null = null;

export function getSshConfig(): SSHConfig {
  if (cached === null) {
    cached = loadSshConfig();
  }
  return cached;
}

export function _resetSshConfigForTesting(): void {
  cached = null;
}
