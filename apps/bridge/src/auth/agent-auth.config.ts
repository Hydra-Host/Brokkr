const MIN_TOKEN_BYTES = 16;

export interface AgentAuthConfig {
  tokenBytes: number;
  discoveryTtlS: number;
  deviceTtlS: number;
}

const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

function parseIntOrDefault(value: string | undefined, def: number): number {
  if (value === undefined) return def;
  if (!STRICT_INT_PATTERN.test(value)) return def;
  return Number.parseInt(value.replace(/_/g, ''), 10);
}

export function buildAgentAuthConfig(env: NodeJS.ProcessEnv = process.env): AgentAuthConfig {
  return {
    tokenBytes: Math.max(MIN_TOKEN_BYTES, parseIntOrDefault(env.AGENT_AUTH_TOKEN_BYTES, 32)),
    discoveryTtlS: parseIntOrDefault(env.AGENT_AUTH_DISCOVERY_TTL_S, 86_400),
    deviceTtlS: parseIntOrDefault(env.AGENT_AUTH_DEVICE_TTL_S, 86_400),
  };
}

let cached: AgentAuthConfig | null = null;

export function getAgentAuthConfig(): AgentAuthConfig {
  if (cached === null) {
    cached = buildAgentAuthConfig();
  }
  return cached;
}

export function resetAgentAuthConfigForTests(): void {
  cached = null;
}
