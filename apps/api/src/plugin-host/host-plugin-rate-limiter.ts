import type { PluginRateLimiter, PluginRateLimitRequest } from '@hydrahost/plugin-sdk';
import { z } from 'zod';

type RawRedis = {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

const EvalResultSchema = z.tuple([z.number().int().positive(), z.number().int()]);

const CONSUME_SCRIPT = `
local ttlSeconds = tonumber(ARGV[1])
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ttlSeconds)
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ttlSeconds)
  ttl = ttlSeconds
end
return {count, ttl}
`;

function validateRequest(request: PluginRateLimitRequest): void {
  if (
    request.name === '' ||
    request.subject === '' ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    !Number.isSafeInteger(request.windowSeconds) ||
    request.windowSeconds < 1
  ) {
    throw new Error('Plugin rate limit request is invalid');
  }
}

export function createPluginRateLimiter(raw: RawRedis, pluginId: string): PluginRateLimiter {
  const prefix = `plugin:${pluginId}:rate-limit:`;

  return {
    async consume(request) {
      validateRequest(request);
      const key = `${prefix}${encodeURIComponent(request.name)}:${encodeURIComponent(request.subject)}`;
      const [count, ttl] = EvalResultSchema.parse(await raw.eval(CONSUME_SCRIPT, 1, key, request.windowSeconds));

      return {
        allowed: count <= request.limit,
        remaining: Math.max(request.limit - count, 0),
        retryAfterSeconds: Math.max(ttl, 1),
      };
    },
  };
}
