import type { IpxeIdentifierBundle } from '../types/render-request.types';

interface IdentifierSource {
  serial?: string | null;
  systemUuid?: string | null;
  chassisSerial?: string | null;
  baseboardSerial?: string | null;
  interfaces?: ReadonlyArray<{ macAddress?: string | null; mgmtOnly?: boolean | null }> | null;
}

export type IdentifierBundle = IpxeIdentifierBundle & {
  interface_macs?: string[];
};

// Omit empty fields (presence feeds the placeholderIdFromBundle hash); interface_macs lets pointer rotation repoint a stale placeholder MAC pointer to the real device.
export function identifierBundleFor(device: IdentifierSource): IdentifierBundle {
  const bundle: IdentifierBundle = {};

  const interfaces = device.interfaces ?? [];
  const dataMac = interfaces.find((i) => !i.mgmtOnly && i.macAddress)?.macAddress;
  const bmcMac = interfaces.find((i) => i.mgmtOnly && i.macAddress)?.macAddress;
  if (dataMac) bundle.mac = dataMac;
  if (bmcMac) bundle.ipmi_mac = bmcMac;
  if (device.systemUuid) bundle.system_uuid = device.systemUuid;
  if (device.serial) bundle.serial = device.serial;
  if (device.chassisSerial) bundle.chassis_serial = device.chassisSerial;
  if (device.baseboardSerial) bundle.board_serial = device.baseboardSerial;

  const interfaceMacs = interfaces
    .map((iface) => iface.macAddress)
    .filter((mac): mac is string => typeof mac === 'string' && mac.length > 0);
  if (interfaceMacs.length > 0) {
    bundle.interface_macs = [...new Set(interfaceMacs)];
  }

  return bundle;
}
