import { z } from 'zod';

import { DOMAIN_NAME_RE } from './dns-records.js';

export const DNS_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export const ownedDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(DOMAIN_NAME_RE, 'Must be a valid DNS domain (RFC 1035 labels)')
  .describe('The authoritative domain suffix the bridge owns (e.g. "lan")');

export const ZoneDnsConfigSchema = z
  .object({
    enabled: z.boolean().describe('Whether the bridge DNS server is active for this zone'),
    upstreamResolvers: z
      .array(z.string().ip({ version: 'v4' }))
      .describe('Upstream DNS resolver IPv4 addresses (e.g. 8.8.8.8)'),
    ttlSeconds: z.number().int().min(0).max(0x7fffffff).describe('Default TTL in seconds for authoritative records'),
    cacheSize: z.number().int().min(0).describe('Maximum number of entries in the resolver cache'),
    ownedDomain: ownedDomainSchema,
    upstreamTimeoutMs: z.number().int().min(1).describe('Timeout in milliseconds for a single upstream resolver query'),
    pollMs: z
      .number()
      .int()
      .min(1)
      .describe('Bridge-side poll interval in milliseconds for DNS config/records atom changes'),
    tcpMaxConnections: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('Maximum concurrent TCP connections (null = server default, must be >= 1)'),
    tcpMaxQueriesPerConn: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('Maximum queries per TCP connection before close (null = server default, must be >= 1)'),
    tcpIdleTimeoutMs: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('Idle timeout in milliseconds before a TCP connection is closed (null = server default, must be >= 1)'),
    tcpMaxMessageBytes: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('Maximum DNS message size in bytes over TCP (null = server default, must be >= 1)'),
    maxTtlSeconds: z.number().int().min(0).nullable().describe('Upper TTL clamp for cached records (null = no clamp)'),
    maxCacheTtlSeconds: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Maximum TTL for cache entries (0 = no cap, null = bridge default)'),
    minCacheTtlSeconds: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Minimum TTL for cache entries (null = honor origin)'),
    negTtlSeconds: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('TTL for negative (NXDOMAIN) cache entries (null = no caching)'),
  })
  .refine(
    (data) =>
      data.minCacheTtlSeconds == null ||
      data.maxCacheTtlSeconds == null ||
      data.maxCacheTtlSeconds === 0 ||
      data.minCacheTtlSeconds <= data.maxCacheTtlSeconds,
    { message: 'minCacheTtlSeconds must be <= maxCacheTtlSeconds', path: ['minCacheTtlSeconds'] },
  );

export type ZoneDnsConfig = z.infer<typeof ZoneDnsConfigSchema>;

export const PrefixDnsOverrideSchema = z.object({
  serveDns: z.boolean().nullable().describe('Whether DNS is served on this prefix (null = inherit zone default)'),
  upstreamOverride: z
    .array(z.string().ip({ version: 'v4' }))
    .describe('Per-prefix upstream resolver IPv4 addresses (empty = inherit zone default)'),
});

export type PrefixDnsOverride = z.infer<typeof PrefixDnsOverrideSchema>;
