import { z } from 'zod';

export const DnsDomainTypeSchema = z
  .enum(['FORWARD', 'REVERSE'])
  .describe('FORWARD for normal domains, REVERSE for in-addr.arpa');

export type DnsDomainType = z.infer<typeof DnsDomainTypeSchema>;

export const DnsRecordTypeSchema = z.enum(['A', 'AAAA', 'PTR']).describe('DNS resource record type');

export type DnsRecordType = z.infer<typeof DnsRecordTypeSchema>;

export const DnsRecordSourceSchema = z
  .enum(['MANUAL', 'AUTO'])
  .describe('Whether the record was created manually or auto-derived from IPAM data');

export type DnsRecordSource = z.infer<typeof DnsRecordSourceSchema>;

/** RFC 952/1123 hostname labels separated by dots, optional trailing dot. Per-label max 63 chars (RFC 1035 s2.3.4). */
export const DOMAIN_NAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

const zodIpv4 = z.string().ip({ version: 'v4' });
const zodIpv6 = z.string().ip({ version: 'v6' });

/** Single DNS label: alphanumeric with interior hyphens, max 63 chars per RFC 1035. */
export const DNS_LABEL_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** PTR fragment: dot-separated hex/decimal segments (reversed octets or nibbles). */
export const PTR_FRAGMENT_RE = /^[a-fA-F0-9]+(\.[a-fA-F0-9]+)*$/;

export const DnsDomainSchema = z.object({
  id: z.string().describe('Unique identifier for the DNS domain'),
  name: z.string().describe('Domain name (e.g. "lan", "10.in-addr.arpa")'),
  type: DnsDomainTypeSchema.describe('Forward or reverse domain type'),
  zoneId: z.string().describe('ID of the zone this domain belongs to'),
  createdAt: z.coerce.date().describe('Timestamp when the domain was created'),
  updatedAt: z.coerce.date().describe('Timestamp when the domain was last updated'),
});

export type DnsDomain = z.infer<typeof DnsDomainSchema>;

export const DnsRecordSchema = z.object({
  id: z.string().describe('Unique identifier for the DNS record'),
  name: z.string().describe('Record name (hostname label or PTR fragment, without the domain suffix)'),
  type: DnsRecordTypeSchema.describe('DNS resource record type'),
  value: z.string().describe('Record value (IP address for A/AAAA, FQDN for PTR)'),
  source: DnsRecordSourceSchema.describe('Whether this record was manually created or auto-derived'),
  ttlOverride: z
    .number()
    .int()
    .nullable()
    .describe('Per-record TTL override in seconds, or null to use the domain default'),
  domainId: z.string().describe('ID of the parent DNS domain'),
  deviceId: z.string().nullable().describe('ID of the device this record is associated with, if any'),
  deviceRole: z
    .string()
    .nullable()
    .describe("Role of the associated device (e.g. 'Server', 'Bridge', 'Switch'), or null when no device is linked"),
  ipAddressId: z.string().nullable().describe('ID of the IPAM IP address this record is associated with, if any'),
  createdAt: z.coerce.date().describe('Timestamp when the record was created'),
  updatedAt: z.coerce.date().describe('Timestamp when the record was last updated'),
});

export type DnsRecord = z.infer<typeof DnsRecordSchema>;

const domainNameField = z
  .string()
  .min(1, 'Domain name is required')
  .max(254, 'Domain name must not exceed 253 characters (254 with trailing dot)')
  .regex(DOMAIN_NAME_RE, 'Domain name must contain only alphanumeric characters, hyphens, and dots')
  .refine(
    (v) => v.replace(/\.$/, '').length <= 253,
    'Domain name must not exceed 253 characters (excluding optional trailing dot)',
  );

export const CreateDnsDomainSchema = z.object({
  name: domainNameField.describe('Domain name to create (e.g. "lan", "10.in-addr.arpa")'),
  type: DnsDomainTypeSchema.default('FORWARD').describe('Forward or reverse domain type'),
});

export type CreateDnsDomain = z.infer<typeof CreateDnsDomainSchema>;

export const UpdateDnsDomainSchema = z.object({
  name: domainNameField.describe('Updated domain name'),
});

export type UpdateDnsDomain = z.infer<typeof UpdateDnsDomainSchema>;

export function validateDnsRecordName(type: DnsRecordType, name: string, ctx: z.RefinementCtx): void {
  if (type === 'PTR') {
    if (!PTR_FRAGMENT_RE.test(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PTR record name must be a dot-separated reverse address fragment',
        path: ['name'],
      });
    }
  } else if (!DNS_LABEL_RE.test(name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Record name must be a valid DNS label (alphanumeric and hyphens, cannot start or end with a hyphen)',
      path: ['name'],
    });
  }
}

export function validateDnsRecordValue(type: DnsRecordType, value: string, ctx: z.RefinementCtx): void {
  switch (type) {
    case 'A': {
      if (!zodIpv4.safeParse(value).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A record value must be a valid IPv4 address',
          path: ['value'],
        });
      }
      break;
    }
    case 'AAAA': {
      if (!zodIpv6.safeParse(value).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'AAAA record value must be a valid IPv6 address',
          path: ['value'],
        });
      }
      break;
    }
    case 'PTR': {
      if (value.length > 254 || !DOMAIN_NAME_RE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PTR record value must be a valid domain name (max 253 chars, labels max 63 chars)',
          path: ['value'],
        });
      }
      break;
    }
  }
}

export const CreateDnsRecordSchema = z
  .object({
    name: z.string().min(1, 'Record name is required').describe('Record name (hostname label or PTR fragment)'),
    type: DnsRecordTypeSchema.describe('DNS resource record type'),
    value: z
      .string()
      .min(1, 'Record value is required')
      .describe('Record value (IPv4 for A, IPv6 for AAAA, FQDN for PTR)'),
    ttlOverride: z
      .number()
      .int()
      .positive()
      .max(0x7fffffff)
      .nullable()
      .optional()
      .describe('Per-record TTL override in seconds'),
  })
  .superRefine((data, ctx) => {
    validateDnsRecordName(data.type, data.name, ctx);
    validateDnsRecordValue(data.type, data.value, ctx);
  });

export type CreateDnsRecord = z.infer<typeof CreateDnsRecordSchema>;

export const UpdateDnsRecordSchema = z
  .object({
    name: z.string().min(1, 'Record name is required').optional().describe('Updated record name'),
    value: z.string().min(1, 'Record value is required').optional().describe('Updated record value'),
    ttlOverride: z
      .number()
      .int()
      .positive()
      .max(0x7fffffff)
      .nullable()
      .optional()
      .describe('Updated per-record TTL override in seconds'),
  })
  .superRefine((data, ctx) => {
    if (data.name !== undefined) {
      const isLabel = DNS_LABEL_RE.test(data.name);
      const isPtrFragment = PTR_FRAGMENT_RE.test(data.name);
      if (!isLabel && !isPtrFragment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Record name must be a valid DNS label or PTR reverse address fragment',
          path: ['name'],
        });
      }
    }
    if (data.value !== undefined) {
      const isIpv4 = zodIpv4.safeParse(data.value).success;
      const isIpv6 = zodIpv6.safeParse(data.value).success;
      const isDomain = data.value.length <= 254 && DOMAIN_NAME_RE.test(data.value);
      if (!isIpv4 && !isIpv6 && !isDomain) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Record value must be a valid IPv4 address, IPv6 address, or domain name',
          path: ['value'],
        });
      }
    }
  });

export type UpdateDnsRecord = z.infer<typeof UpdateDnsRecordSchema>;

export const DnsRecordListQuerySchema = z.object({
  source: DnsRecordSourceSchema.optional().describe('Filter records by source'),
});

export type DnsRecordListQuery = z.infer<typeof DnsRecordListQuerySchema>;
