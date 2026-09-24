export interface MacBearingInterface {
  macAddress?: string | null;
  mgmtOnly?: boolean | null;
  ipAddresses?: readonly unknown[] | null;
}

export type DataMacTier = 'address' | 'name-order';

const isData = (i: MacBearingInterface): boolean => !i.mgmtOnly && !!i.macAddress;
const hasAddress = (i: MacBearingInterface): boolean => (i.ipAddresses?.length ?? 0) > 0;

/** The interface that PXE-boots: the first data interface holding an address, else the first with a MAC, in the caller's order. */
export function pickDataInterface<T extends MacBearingInterface>(
  interfaces: readonly T[],
): { iface: T; tier: DataMacTier } | undefined {
  const addressed = interfaces.find((i) => isData(i) && hasAddress(i));
  if (addressed) return { iface: addressed, tier: 'address' };
  const any = interfaces.find(isData);
  return any ? { iface: any, tier: 'name-order' } : undefined;
}

export function pickDataMac<T extends MacBearingInterface>(interfaces: readonly T[]): T | undefined {
  return pickDataInterface(interfaces)?.iface;
}

export function pickBmcMac<T extends MacBearingInterface>(interfaces: readonly T[]): T | undefined {
  return interfaces.find((i) => !!i.mgmtOnly && !!i.macAddress);
}
