export const IPXE_CUSTOM_SLUGS = ['ipxe-custom', 'ipxe-custom-tee'] as const;

export type IpxeCustomSlug = (typeof IPXE_CUSTOM_SLUGS)[number];

// Takes `unknown` so the bridge can call it on an unvalidated saga payload; the predicate keeps
// callers that already hold a string from losing the argument check.
export function isIpxeCustomOs(slug: unknown): slug is IpxeCustomSlug {
  return IPXE_CUSTOM_SLUGS.some((candidate) => candidate === slug);
}
