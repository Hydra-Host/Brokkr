export type PxeDecision = 'offered' | 'refused-allowlist' | 'no-subnet';

export interface PxeObserver {
  onDecision(mac: string, decision: PxeDecision): void;
}

export const NOOP_PXE_OBSERVER: PxeObserver = { onDecision: () => undefined };

export const PXE_DECISION_TTL_SECONDS = 7 * 24 * 60 * 60;
