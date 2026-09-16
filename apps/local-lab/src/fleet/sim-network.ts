import type { OverlayStoreService } from '../services/overlay-store';

/** The simulator's own data and BMC networks; the bare-metal uplink must sit on neither. */
export function simNetworkCidrs(config: ReturnType<OverlayStoreService['fleetConfig']>): string[] {
  const network = config?.network ?? {};
  return [network.cidr, network.bmc_cidr].filter((v): v is string => typeof v === 'string' && v !== '');
}
