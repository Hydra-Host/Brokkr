import { z } from 'zod';

export const OS_SLUG_DESCRIPTION_PREFIX = 'Identifier slug for a base OS layer';

export const OperatingSystemSlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9.-]+$/, 'OS slug must contain only lowercase letters, numbers, dots, and hyphens')
  .describe(`${OS_SLUG_DESCRIPTION_PREFIX} (kind=BASE). Must exist in the Layer catalog.`);

export type OperatingSystemSlug = z.infer<typeof OperatingSystemSlugSchema>;

export { IPXE_CUSTOM_SLUGS, isIpxeCustomOs, type IpxeCustomSlug } from '@repo/utils';

export const BooleanQueryParamSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1')
  .describe('Boolean filter. Accepts true/false or the strings "true"/"false"/"1"/"0".');

const IPXE_ALLOWED_PROTOCOLS = ['http:', 'https:'];
export const IpxeBootUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        return IPXE_ALLOWED_PROTOCOLS.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'iPXE boot URL must use the http or https scheme' },
  )
  .describe('Custom iPXE script URL for network boot. Must be an http or https URL.');
