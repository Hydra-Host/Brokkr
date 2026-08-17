import { z } from 'zod';

const platformSlugPattern = /^[a-zA-Z0-9_-]*$/;
const macFieldPattern = /^[0-9A-Fa-f:.-]*$/;

// Length caps: attacker-supplied facts persist to discovery:pending:<mac> for 30 days, so unbounded values are a Redis storage-amplification / poisoning vector.
export const ipxeChainBodySchema = z.object({
  platform: z.string().max(64).regex(platformSlugPattern, 'platform must contain only [a-zA-Z0-9_-]').default(''),
  buildarch: z.string().max(32).default(''),
  ip: z.string().max(64).default(''),
  mac: z.string().max(64).regex(macFieldPattern, 'mac must contain only hex digits and [:.-]').default(''),
  serial: z.string().max(256).default(''),
  manufacturer: z.string().max(256).default(''),
  ipmi_mac: z.string().max(64).default(''),
  ipmi_ip: z.string().max(64).default(''),
  ipmi_tag: z.string().max(128).default(''),
  board_serial: z.string().max(256).default(''),
  chassis_serial: z.string().max(256).default(''),
  system_uuid: z.string().max(64).default(''),
  retry_count: z
    .string()
    .default('0')
    .transform((raw) => {
      const n = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }),
});

export type IpxeChainBody = z.infer<typeof ipxeChainBodySchema>;

export const chainUnreachableQuerySchema = z.object({
  mac: z.string().regex(macFieldPattern, 'mac must contain only hex digits and [:.-]').default(''),
  attempts: z
    .string()
    .default('0')
    .transform((raw) => {
      const n = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }),
});

export type ChainUnreachableQuery = z.infer<typeof chainUnreachableQuerySchema>;

export const ipxeScriptResponseSchema = z.object({
  content_type: z.string().default('text/plain'),
  body: z.string(),
});

export type IpxeScriptResponse = z.infer<typeof ipxeScriptResponseSchema>;

export const ipxeTextErrorResponseSchema = z.object({
  content_type: z.string().default('text/plain'),
  body: z.string(),
});

export type IpxeTextErrorResponse = z.infer<typeof ipxeTextErrorResponseSchema>;
