// Keep in sync with apps/bridge/src/dns/dns-atom-value.schema.ts (separate app/deploy).

import { ownedDomainSchema } from '@repo/api-client';
import { z } from 'zod';

export const DnsConfigAtomSchema = z
  .object({
    enabled: z.boolean().describe('Whether DNS serving is enabled for this zone.'),
    upstreamResolvers: z
      .array(z.string().ip({ version: 'v4' }))
      .describe('Upstream DNS forwarder IPs for recursive resolution.'),
    ttlSeconds: z.number().int().min(0).max(0x7fffffff).describe('Default TTL for authoritative answers in seconds.'),
    cacheSize: z.number().int().min(0).describe('DNS cache capacity (0 = caching disabled).'),
    ownedDomain: ownedDomainSchema.describe('Owned domain suffix, e.g. "lan".'),
    hostnames: z
      .array(z.string().min(1))
      .describe('Bridge hostnames in this zone that the DNS server answers for authoritatively.'),
    upstreamTimeoutMs: z.number().int().min(1).optional().describe('Upstream query timeout in milliseconds.'),
    pollMs: z.number().int().min(1).optional().describe('Bridge-side config/records poll interval in milliseconds.'),
    // TCP is always on when DNS is enabled; emitted as literal true so already-deployed
    // bridges whose schema still requires the field keep parsing the atom.
    tcpEnabled: z.literal(true).describe('Always true — the TCP listener is no longer toggleable.'),
    tcpMaxConnections: z.number().int().min(1).optional().describe('Maximum concurrent TCP connections.'),
    tcpMaxQueriesPerConn: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum queries allowed per TCP connection before close.'),
    tcpIdleTimeoutMs: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('TCP idle timeout in milliseconds before connection is closed.'),
    tcpMaxMessageBytes: z.number().int().min(1).optional().describe('Maximum DNS message size in bytes over TCP.'),
    maxTtlSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Global TTL cap applied to upstream responses (0 = no cap).'),
    maxCacheTtlSeconds: z.number().int().min(0).optional().describe('Upper bound on cached entry TTL (0 = no cap).'),
    minCacheTtlSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Floor on cached entry TTL to prevent excessive re-queries.'),
    negTtlSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Negative response cache TTL in seconds (0 = no negative caching).'),
  })
  .strict();

export type DnsConfigAtom = z.infer<typeof DnsConfigAtomSchema>;

export const DnsPrefixOverrideAtomSchema = z
  .object({
    serveDns: z
      .boolean()
      .nullable()
      .describe('Per-prefix DNS toggle: true=force on, false=force off, null=inherit zone.'),
    upstreamOverride: z
      .array(z.string().ip({ version: 'v4' }))
      .nullable()
      .describe('Per-prefix upstream resolver override (empty array or null = inherit zone).'),
  })
  .strict();

export type DnsPrefixOverrideAtom = z.infer<typeof DnsPrefixOverrideAtomSchema>;
