export function sanitizeRedirect(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  if (!path.startsWith('/') || path.startsWith('//')) return undefined;
  if (path === '/') return undefined;
  if (path.startsWith('/auth') || path.startsWith('/onboarding')) return undefined;
  return path;
}
