export const FRESHNESS_WINDOW_MS = 300_000;
export const SKEW_TOLERANCE_MS = 60_000;

export const DIRECTION_HUB_TO_BRIDGE = 'hub_to_bridge';
export const DIRECTION_BRIDGE_TO_HUB = 'bridge_to_hub';

export const CURRENT_AAD_VERSION = 1;
export const CURRENT_ENVELOPE_VERSION = 1;

export const REASON_KEY_UNKNOWN = 'key_unknown';
export const REASON_SEAL_FAILED = 'seal_failed';
export const REASON_TAMPER = 'tamper';
export const REASON_STALE = 'stale';
export const REASON_FUTURE_SKEW = 'future_skew';
export const REASON_ROUTING_MISMATCH = 'routing_mismatch';
export const REASON_MALFORMED_ENVELOPE = 'malformed_envelope';

export interface Envelope {
  envelope_v: number;
  aad: Record<string, unknown>;
  eph_pub: string;
  ciphertext: string;
  tag: string;
}

export interface ExpectedRouting {
  zoneId: string;
  queueName: string;
}
