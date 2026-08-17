import type { DeliveryStatus, DeviceTokenStatus, LifecycleJobPhase } from '@/contract';
import { DELIVERY_STATUSES, DEVICE_TOKEN_STATUSES, LIFECYCLE_JOB_PHASES } from '@/contract';

export type HubTab = 'webhooks' | 'lifecycle' | 'tokens';

export interface HubSearch {
  tab: HubTab;
  deliveryStatus: DeliveryStatus | undefined;
  webhookId: string | undefined;
  phases: LifecycleJobPhase[];
  jobId: string | undefined;
  deviceId: string | undefined;
  tokenStatus: DeviceTokenStatus | undefined;
  tokenId: string | undefined;
}

// annotated, not inferred: a new tab must widen the union deliberately rather than by being listed here
const HUB_TAB_IDS: readonly HubTab[] = ['webhooks', 'lifecycle', 'tokens'];

export function isHubTab(value: unknown): value is HubTab {
  return HUB_TAB_IDS.some((id) => id === value);
}

export function toHubTab(value: unknown): HubTab {
  return isHubTab(value) ? value : 'lifecycle';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((entry) => entry === value);
}

/** Both shapes on purpose: the router round-trips an array, a hand-edited url carries the csv the
 *  api takes. An unknown phase is dropped here and rejected there, since a url is hand-editable. */
function phaseList(value: unknown): LifecycleJobPhase[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .flatMap((entry) => {
      const match = oneOf(LIFECYCLE_JOB_PHASES, entry);
      return match ? [match] : [];
    });
}

export function validateHubSearch(search: Record<string, unknown>): HubSearch {
  return {
    tab: toHubTab(search.tab),
    deliveryStatus: oneOf(DELIVERY_STATUSES, search.deliveryStatus),
    webhookId: text(search.webhookId),
    phases: phaseList(search.phases),
    jobId: text(search.jobId),
    deviceId: text(search.deviceId),
    tokenStatus: oneOf(DEVICE_TOKEN_STATUSES, search.tokenStatus),
    tokenId: text(search.tokenId),
  };
}

// a search reducer must return every param, hence the total validator over prev rather than a spread
export function jobLifecycleSearch(prev: Record<string, unknown>, jobId: string): HubSearch {
  return { ...validateHubSearch(prev), tab: 'lifecycle', jobId, phases: [] };
}

// the status filter is cleared with the selection: a card link must land on every token the device
// has, or "no tokens match" reads as the device having none
export function deviceTokensSearch(prev: Record<string, unknown>, deviceId: string): HubSearch {
  return { ...validateHubSearch(prev), tab: 'tokens', deviceId, tokenId: undefined, tokenStatus: undefined };
}
