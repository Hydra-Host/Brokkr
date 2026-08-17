import type { DhcpReservation } from './dhcp.config.js';
import { ipToInt } from './dhcp.config.js';

export interface DhcpPoolCandidate {
  rangeStart: string;
  rangeEnd: string;
  subnetMask: string;
  serverId: string;
  reservations: DhcpReservation[];
  routers: string[];
}

function inSubnet(ip: string, serverIdInt: number, maskInt: number): boolean {
  return (ipToInt(ip) & maskInt) === serverIdInt;
}

export function validateDhcpPoolConsistency(pool: DhcpPoolCandidate): void {
  const hasRange = pool.rangeStart !== '' || pool.rangeEnd !== '';

  if (hasRange) {
    if (pool.rangeStart === '' || pool.rangeEnd === '') {
      throw new Error('Invalid DHCP pool: a range needs both a start and an end address');
    }
    if (ipToInt(pool.rangeEnd) < ipToInt(pool.rangeStart)) {
      throw new Error(`Invalid DHCP pool: range end ${pool.rangeEnd} is below range start ${pool.rangeStart}`);
    }
  }

  if (!hasRange && pool.reservations.length === 0) {
    throw new Error('Invalid DHCP pool: no dynamic range and no reservations — nothing to serve');
  }

  if (pool.serverId !== '') {
    const maskInt = ipToInt(pool.subnetMask);
    const serverIdInt = ipToInt(pool.serverId) & maskInt;

    for (const reservation of pool.reservations) {
      if (!inSubnet(reservation.ip, serverIdInt, maskInt)) {
        throw new Error(
          `Invalid DHCP pool: reservation ${reservation.mac}=${reservation.ip} is outside the subnet of server ${pool.serverId}/${pool.subnetMask}`,
        );
      }
    }

    for (const router of pool.routers) {
      if (router === '0.0.0.0') continue;
      if (!inSubnet(router, serverIdInt, maskInt)) {
        throw new Error(
          `Invalid DHCP pool: gateway ${router} is outside the subnet of server ${pool.serverId}/${pool.subnetMask}`,
        );
      }
    }

    if (
      hasRange &&
      (!inSubnet(pool.rangeStart, serverIdInt, maskInt) || !inSubnet(pool.rangeEnd, serverIdInt, maskInt))
    ) {
      throw new Error(
        `Invalid DHCP pool: range ${pool.rangeStart}-${pool.rangeEnd} is outside the subnet of server ${pool.serverId}/${pool.subnetMask}`,
      );
    }
  }

  // In-pool reservations are intentionally allowed: the allocator skips reservedIps
  // when leasing from a pool (subnet.ts), so a reserved IP is never handed out.
}
