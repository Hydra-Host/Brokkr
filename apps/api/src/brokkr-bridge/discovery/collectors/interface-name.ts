// detect bmc usb nic
export function isUsbIpmiNicName(name: string): boolean {
  return /^enx[0-9a-f]{12}$/i.test(name);
}

// udev name from kernel name
export function osInterfaceName(ifname: string, altnames: readonly string[] = []): string {
  if (!/^eth\d+$/.test(ifname)) return ifname;
  return altnames.find((name) => name && !isUsbIpmiNicName(name)) ?? ifname;
}
