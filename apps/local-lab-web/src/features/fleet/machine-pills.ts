import type { BmcProbe } from '@/contract';

const ONLINE_TONE = 'text-status-online/90';
const WARNING_TONE = 'text-status-warning/90';

export type PillValue = { value: string; tone: string };

export function bmcPill(bmc: BmcProbe | null): PillValue {
  const value = bmc === null ? 'n/a' : bmc.reachable === 'ok' ? (bmc.powerState ?? 'ok') : bmc.reachable;
  return { value, tone: bmc?.reachable === 'ok' ? ONLINE_TONE : WARNING_TONE };
}

/** `identitySplit` is the config page's PXE-106 reading; the fleet card has no findings scan of its own and takes the default. */
export function hubPill(deviceId: string | null, identitySplit = false): PillValue {
  const value = identitySplit ? 'split' : deviceId === null ? 'no device' : deviceId;
  return { value, tone: identitySplit || deviceId === null ? WARNING_TONE : ONLINE_TONE };
}
