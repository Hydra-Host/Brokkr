export const PLUGIN_RATE_LIMITER = Symbol.for('@hydrahost/plugin-sdk/RATE_LIMITER');

export interface PluginRateLimitPolicy {
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface PluginRateLimitRequest extends PluginRateLimitPolicy {
  subject: string;
}

export interface PluginRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface PluginRateLimiter {
  consume(request: PluginRateLimitRequest): Promise<PluginRateLimitResult>;
}
