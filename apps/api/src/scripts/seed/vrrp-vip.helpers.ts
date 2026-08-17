/** Derives a host address on the zone's data-plane prefix, e.g. `192.168.203.0/24` + 240 → `192.168.203.240`. */
export function deriveSeedAddress(dataPlaneCidr: string, hostOctet: number): string {
  const [network, lengthStr] = dataPlaneCidr.split('/');
  if (Number(lengthStr) !== 24) {
    throw new Error(`deriveSeedAddress only supports /24 prefixes; got ${dataPlaneCidr}`);
  }
  const octets = network.split('.');
  return `${octets.slice(0, 3).join('.')}.${hostOctet}`;
}
