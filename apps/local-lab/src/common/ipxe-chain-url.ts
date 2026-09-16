import { PORTS } from '../ports';

/** Baked into the iPXE binaries and compared byte-for-byte against the served URL to detect a stale
 *  bake, so every site derives it here. */
export const ipxeChainBaseUrl = (uplink: { ip: string }): string => `http://${uplink.ip}:${PORTS.spoke.base}`;
