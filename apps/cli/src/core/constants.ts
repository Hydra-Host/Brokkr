export const EXPIRATION_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: 'No expiration' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
];

export const VALID_POWER_ACTIONS = ['on', 'off', 'cycle'] as const;
export type PowerAction = (typeof VALID_POWER_ACTIONS)[number];

export const VALID_RESCUE_ACTIONS = ['activate', 'deactivate'] as const;
export type RescueAction = (typeof VALID_RESCUE_ACTIONS)[number];
