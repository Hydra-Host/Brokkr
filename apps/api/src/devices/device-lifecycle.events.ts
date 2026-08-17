export const DeviceLifecycleEvent = {
  SoftDeleted: 'device.soft-deleted',
} as const;

export interface DeviceSoftDeletedEvent {
  deviceId: string;
}
