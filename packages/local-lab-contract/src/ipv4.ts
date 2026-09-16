// the lab and lab-web reach the shared IPv4 helpers through this barrel; local-sim parity is pinned by
// packages/utils/src/ipv4.vectors.json.
export { intToIpv4, ipAtOffset, ipInCidr, ipv4ToInt, isIpv4, networkBase, parseCidr } from '@repo/utils';

export const NODE_IP_BASE = 10;
