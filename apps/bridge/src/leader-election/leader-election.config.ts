import { hostname } from 'node:os';

import { z } from 'zod';
import { envInt } from '../common/env-utils';

const envSchema = z
  .object({
    BRIDGE_HOSTNAME: z.string().optional(),
    LEADER_TTL_SECONDS: envInt(30),
    LEADER_RENEW_INTERVAL_SECONDS: envInt(10),
    LEADER_HEARTBEAT_TIMEOUT_SECONDS: envInt(15),
    REGISTRY_TTL_SECONDS: envInt(120),
  })
  // TTL must exceed renew interval + heartbeat timeout or leadership flaps; fail fast on a violating operator override.
  .superRefine((env, ctx) => {
    const floor = env.LEADER_RENEW_INTERVAL_SECONDS + env.LEADER_HEARTBEAT_TIMEOUT_SECONDS;
    if (env.LEADER_TTL_SECONDS <= floor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `LEADER_TTL_SECONDS (${env.LEADER_TTL_SECONDS}) must exceed ` +
          `LEADER_RENEW_INTERVAL_SECONDS + LEADER_HEARTBEAT_TIMEOUT_SECONDS ` +
          `(${env.LEADER_RENEW_INTERVAL_SECONDS} + ${env.LEADER_HEARTBEAT_TIMEOUT_SECONDS} = ${floor})`,
      });
    }
  });

export interface LeaderConfig {
  instanceId: string;
  leaderTtlSeconds: number;
  leaderRenewIntervalSeconds: number;
  leaderHeartbeatTimeoutSeconds: number;
  registryTtlSeconds: number;
  leaderKey: string;
  registryKeyPrefix: string;
}

export function buildLeaderConfig(env: NodeJS.ProcessEnv = process.env): LeaderConfig {
  const parsed = envSchema.parse(env);
  return {
    instanceId: parsed.BRIDGE_HOSTNAME ?? hostname(),
    leaderTtlSeconds: parsed.LEADER_TTL_SECONDS,
    leaderRenewIntervalSeconds: parsed.LEADER_RENEW_INTERVAL_SECONDS,
    leaderHeartbeatTimeoutSeconds: parsed.LEADER_HEARTBEAT_TIMEOUT_SECONDS,
    registryTtlSeconds: parsed.REGISTRY_TTL_SECONDS,
    leaderKey: 'bridge:leader',
    registryKeyPrefix: 'bridge:instance:',
  };
}

let cached: LeaderConfig | null = null;

export function getLeaderConfig(): LeaderConfig {
  if (cached === null) {
    cached = buildLeaderConfig();
  }
  return cached;
}

export function resetLeaderConfigForTests(): void {
  cached = null;
}
