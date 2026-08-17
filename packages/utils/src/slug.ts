// Returns `''` when the input has no alphanumeric characters; callers that
// require a non-empty slug must guard for that themselves.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
