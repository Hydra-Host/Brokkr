import { z } from 'zod';

const DnsRecordEntrySchema = z.object({
  name: z.string().describe('Hostname part (e.g. "server-1" for server-1.lan).'),
  type: z.enum(['A', 'AAAA', 'PTR']).describe('DNS record type.'),
  value: z.string().describe('IP address (A/AAAA) or hostname (PTR).'),
  ttl: z.number().int().min(0).nullable().describe('Per-record TTL override in seconds; null inherits zone default.'),
});

export type DnsRecordEntry = z.infer<typeof DnsRecordEntrySchema>;

const DnsDomainEntrySchema = z.object({
  name: z.string().describe('Domain name (e.g. "lan" or "1.0.10.in-addr.arpa").'),
  type: z.enum(['FORWARD', 'REVERSE']).describe('Domain type: FORWARD for A/AAAA, REVERSE for PTR.'),
  records: z.array(DnsRecordEntrySchema).describe('DNS records belonging to this domain.'),
});

export type DnsDomainEntry = z.infer<typeof DnsDomainEntrySchema>;

export const DnsRecordsAtomValueSchema = z.object({
  domains: z.array(DnsDomainEntrySchema).describe('All DNS domains and their records for this zone.'),
});

export type DnsRecordsAtomValue = z.infer<typeof DnsRecordsAtomValueSchema>;
