import { describe, expect, it } from 'vitest';

import { BOOT_RELEVANT_STATUSES, bootPollInterval } from '../boot-poll';
import { BOOT_TRAIL_POLL_MS } from '../poll-intervals';

describe('bootPollInterval', () => {
  it('polls while the device is in a boot-relevant status and stops otherwise', () => {
    expect(bootPollInterval('provisioning')).toBe(BOOT_TRAIL_POLL_MS);
    expect(bootPollInterval('Inventory')).toBe(BOOT_TRAIL_POLL_MS);
    expect(bootPollInterval('commissioning')).toBe(BOOT_TRAIL_POLL_MS);
    expect(bootPollInterval('Reprovisioning')).toBe(BOOT_TRAIL_POLL_MS);
    expect(bootPollInterval('deprovisioning')).toBe(BOOT_TRAIL_POLL_MS);
    expect(bootPollInterval('provisioned')).toBe(false);
    expect(bootPollInterval(null)).toBe(false);
    expect(bootPollInterval(undefined)).toBe(false);
  });

  it('polls whenever the hub expects a network boot whatever the status says', () => {
    expect(bootPollInterval('provisioned', true)).toBe(BOOT_TRAIL_POLL_MS);
    expect(bootPollInterval(null, true)).toBe(BOOT_TRAIL_POLL_MS);
  });

  it('falls back to the status set when no boot is expected or the trail has not loaded', () => {
    expect(bootPollInterval('provisioned', false)).toBe(false);
    expect(bootPollInterval('provisioned', null)).toBe(false);
    expect(bootPollInterval('provisioning', false)).toBe(BOOT_TRAIL_POLL_MS);
    expect(bootPollInterval('provisioning', null)).toBe(BOOT_TRAIL_POLL_MS);
  });

  it('names exactly the statuses that poll', () => {
    expect([...BOOT_RELEVANT_STATUSES].sort()).toEqual([
      'commissioning',
      'deprovisioning',
      'inventory',
      'provisioning',
      'reprovisioning',
    ]);
  });
});
