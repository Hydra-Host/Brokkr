export type OwnerManagementAvailability =
  | { state: 'loading'; message: string }
  | { state: 'unavailable'; message: string }
  | { state: 'ready' };

export function getOwnerManagementAvailability({
  isLoading,
  loadFailed,
  isOwnerCapableActor,
  hasOwnerCapableRole,
}: {
  isLoading: boolean;
  loadFailed: boolean;
  isOwnerCapableActor: boolean;
  hasOwnerCapableRole: boolean;
}): OwnerManagementAvailability {
  if (isLoading) return { state: 'loading', message: 'Loading owner controls…' };
  if (loadFailed)
    return { state: 'unavailable', message: 'Owner controls could not be loaded. Refresh and try again.' };
  if (!isOwnerCapableActor) {
    return { state: 'unavailable', message: 'Only an organization owner can manage owner access.' };
  }
  if (!hasOwnerCapableRole) {
    return { state: 'unavailable', message: 'No owner-capable role is available.' };
  }
  return { state: 'ready' };
}
