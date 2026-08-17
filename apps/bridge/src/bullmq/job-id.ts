export type JobIdDeviceId = string | number;

export function makeJobId(deviceId: JobIdDeviceId, suffix: string): string {
  return `${deviceId}-${suffix}`;
}
