export function contributionAllowed(
  requiredPermission: { resource: string; action: string } | undefined,
  can: (resource: string, action: string) => boolean,
  isLoading: boolean,
): boolean {
  if (!requiredPermission) return true;
  if (isLoading) return false;
  return can(requiredPermission.resource, requiredPermission.action);
}
