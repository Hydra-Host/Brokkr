const LEGACY_OS_SLUG_LABELS: Record<string, string> = {
  ubuntu2004: 'Ubuntu 20.04',
  'ubuntu-20-04': 'Ubuntu 20.04',
  ubuntu2204: 'Ubuntu 22.04',
  'ubuntu-22-04': 'Ubuntu 22.04',
};

export function formatLegacyOsSlug(slug: string | null | undefined): string | undefined {
  if (!slug) return undefined;
  return LEGACY_OS_SLUG_LABELS[slug] ?? slug;
}
