import { z } from 'zod';

export const DnsRecordsAtomSchema = z
  .object({
    domains: z
      .array(
        z
          .object({
            name: z.string().describe('Domain name, e.g. example.lan'),
            type: z.enum(['FORWARD', 'REVERSE']).describe('Domain type.'),
            records: z
              .array(
                z
                  .object({
                    name: z.string().describe('Record name (hostname part).'),
                    type: z.enum(['A', 'AAAA', 'PTR']).describe('DNS record type.'),
                    value: z.string().describe('IP address for A/AAAA, hostname for PTR.'),
                    ttl: z.number().int().min(0).nullable().describe('TTL override; null inherits zone default.'),
                  })
                  .strict(),
              )
              .describe('DNS records belonging to this domain.'),
          })
          .strict(),
      )
      .describe('All DNS domains and their records for this zone.'),
  })
  .strict();

export type DnsRecordsAtom = z.infer<typeof DnsRecordsAtomSchema>;
