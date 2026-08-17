import { ServerLifecycleStatus } from '@repo/database';

export enum StatusTransitionType {
  InventorySuccess = 'inventorySuccess',
  ProvisionSuccess = 'provisionSuccess',
  FailedStatus = 'failedStatus',
}

export function detectStatusTransition(
  previousStatus: ServerLifecycleStatus | null | undefined,
  newStatus: ServerLifecycleStatus | null | undefined,
): StatusTransitionType | null {
  if (previousStatus === newStatus) return null;
  if (!newStatus) return null;

  if (
    newStatus === ServerLifecycleStatus.INVENTORY &&
    previousStatus !== ServerLifecycleStatus.INVENTORY &&
    previousStatus !== ServerLifecycleStatus.OFFLINE
  ) {
    return StatusTransitionType.InventorySuccess;
  }

  if (previousStatus === ServerLifecycleStatus.PROVISIONING && newStatus === ServerLifecycleStatus.PROVISIONED) {
    return StatusTransitionType.ProvisionSuccess;
  }

  if (newStatus === ServerLifecycleStatus.FAILED && previousStatus !== ServerLifecycleStatus.FAILED) {
    return StatusTransitionType.FailedStatus;
  }

  return null;
}
