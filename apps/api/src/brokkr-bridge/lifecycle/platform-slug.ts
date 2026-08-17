export function parsePlatformSlug(slug: string, osDistro: string, osVersion: string) {
  const parts = slug.split('-');
  const codename = parts.length >= 2 ? parts[1] : slug;

  return { slug, codename, os_version: osVersion, os_distro: osDistro, variant: platformVariant(slug) };
}

export function platformVariant(slug: string): string {
  const parts = slug.split('-');
  return parts.length >= 3 ? parts.slice(2).join('-') : 'vanilla';
}
