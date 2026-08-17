import { z } from 'zod';

import { LEASE_MAC_RE } from '../dhcp.config.js';

import type { LeaseRecord } from './lease-record.js';

const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]\\d|\\d)';
const STRICT_IPV4_RE = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

export const leaseRecordSchema = z.object({
  ip: z
    .string()
    .regex(STRICT_IPV4_RE)
    .describe('Leased IPv4 address (octet-bounded dotted-quad), the per-lease Redis key suffix.'),
  mac: z
    .string()
    .regex(LEASE_MAC_RE)
    .describe('Client hardware address, lowercase colon-hex (formatMac form, 1–16 octets).'),
  hostname: z
    .union([z.null(), z.string().min(1).max(63).regex(HOSTNAME_LABEL_RE)])
    .describe('Single legal DNS label recorded on the lease, or null for no hostname.'),
  expiresAt: z
    .number()
    .int()
    .nonnegative()
    .describe('Absolute lease expiry in epoch SECONDS (verbatim; pruned on load when <= now).'),
});

export type LeaseRecordParsed = z.infer<typeof leaseRecordSchema>;

const _drift = (record: LeaseRecord): z.input<typeof leaseRecordSchema> => record;
void _drift;
