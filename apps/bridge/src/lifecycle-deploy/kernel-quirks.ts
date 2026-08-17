export const PCI_REALLOC_OFF_DEVICE_TYPES: ReadonlySet<string> = new Set(['poweredge-xe9780']);

export function needsPciReallocOffFromSlug(deviceType: string | null | undefined): boolean {
  return deviceType !== null && deviceType !== undefined && PCI_REALLOC_OFF_DEVICE_TYPES.has(deviceType);
}

export function needsPciReallocOff(deviceData: Record<string, unknown> | null | undefined): boolean {
  const deviceType = deviceData?.['device_type'];
  return typeof deviceType === 'string' && needsPciReallocOffFromSlug(deviceType);
}
