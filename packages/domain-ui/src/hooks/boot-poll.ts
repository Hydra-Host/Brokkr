import { BOOT_TRAIL_POLL_MS } from './poll-intervals';

// the hub's bootExpected is the primary signal; the status set only covers fetches made before the trail has loaded
export const BOOT_RELEVANT_STATUSES: ReadonlySet<string> = new Set([
  'inventory',
  'commissioning',
  'provisioning',
  'reprovisioning',
  'deprovisioning',
]);

export function bootPollInterval(
  status: string | null | undefined,
  bootExpected: boolean | null = null,
): number | false {
  if (bootExpected === true) return BOOT_TRAIL_POLL_MS;
  return BOOT_RELEVANT_STATUSES.has((status ?? '').toLowerCase()) ? BOOT_TRAIL_POLL_MS : false;
}
