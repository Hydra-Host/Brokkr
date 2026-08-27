// Mirrors hub's DnsConfigAtomSchema; top-level .strict() omitted for rolling-upgrade tolerance.

import { z } from 'zod';

// RFC 1035 labels: letters, digits, hyphens; no leading/trailing hyphen; max 253 chars total
const DNS_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export const DnsConfigAtomValueSchema = z.object({
  enabled: z.boolean(),
  upstreamResolvers: z.array(z.string().ip({ version: 'v4' })),
  ttlSeconds: z.number().int().min(0).max(0x7fffffff),
  cacheSize: z.number().int().min(0),
  ownedDomain: z
    .string()
    .min(1)
    .max(253)
    .regex(DNS_DOMAIN_PATTERN, 'Must be a valid DNS domain (RFC 1035 labels)')
    .refine(
      (val) => val.split('.').every((label) => label.length <= 63),
      'Each DNS label must be at most 63 characters (RFC 1035)',
    ),
  hostnames: z.array(z.string().min(1)),
  upstreamTimeoutMs: z.number().int().min(1).optional(),
  pollMs: z.number().int().min(1).optional(),
  // Ignored — the TCP listener is always on when DNS is enabled; kept optional so atoms from an
  // older hub (which emitted a boolean) still parse.
  tcpEnabled: z.boolean().optional(),
  tcpMaxConnections: z.number().int().min(1).optional(),
  tcpMaxQueriesPerConn: z.number().int().min(1).optional(),
  tcpIdleTimeoutMs: z.number().int().min(1).optional(),
  tcpMaxMessageBytes: z.number().int().min(1).optional(),
  maxTtlSeconds: z.number().int().min(0).optional(),
  maxCacheTtlSeconds: z.number().int().min(0).optional(),
  minCacheTtlSeconds: z.number().int().min(0).optional(),
  negTtlSeconds: z.number().int().min(0).optional(),
});

export type DnsConfigAtomValue = z.infer<typeof DnsConfigAtomValueSchema>;

export const DnsPrefixOverrideAtomValueSchema = z.object({
  serveDns: z.boolean().nullable(),
  upstreamOverride: z.array(z.string().ip({ version: 'v4' })).nullable(),
  // Optional so atoms from an older hub (which omitted the prefix CIDR) still parse.
  cidr: z.string().cidr({ version: 'v4' }).optional(),
});

export type DnsPrefixOverrideAtomValue = z.infer<typeof DnsPrefixOverrideAtomValueSchema>;
