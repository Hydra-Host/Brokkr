import type { DhcpStandbyHealth } from '../dhcp/dhcp-manager.service.js';

type StandbyHealthGetter = () => DhcpStandbyHealth | null;

let getter: StandbyHealthGetter | null = null;

export function setDhcpStandbyHealthGetter(value: StandbyHealthGetter | null): void {
  getter = value;
}

export function clearDhcpStandbyHealthGetter(): void {
  getter = null;
}

export function getDhcpStandbyHealth(): DhcpStandbyHealth | null {
  return getter?.() ?? null;
}

export function resetDhcpStandbyHealthGetterForTests(): void {
  getter = null;
}
