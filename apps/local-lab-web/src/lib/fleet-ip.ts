import { ipAtOffset, NODE_IP_BASE } from '@/contract';

export type NodeIpDisplay = { value: string; isOverride: boolean };

/** the server folds a set static override into effective_*, so it names the derived address only when none is set */
export const derivedIp = (override: string | null, effective: string | null): string | null =>
  override ? null : effective;

/** one predicate for the value and the override styling, so a cleared override cannot render as a non-override */
export const nodeIpDisplay = (
  override: string | null,
  derived: string | null,
  cidr: string,
  index: number,
): NodeIpDisplay =>
  override
    ? { value: override, isOverride: true }
    : { value: derived ?? ipAtOffset(cidr, NODE_IP_BASE + index), isOverride: false };

export type FleetNet = { cidr: string; bmcCidr: string };

/** effective_* were derived from the cidrs of the response that filled the form, so a later cidr change makes them wrong */
export const derivedIpsStale = (hydrated: FleetNet, live: FleetNet): boolean =>
  hydrated.cidr !== live.cidr || hydrated.bmcCidr !== live.bmcCidr;
