import { ServerLifecycleStatus, ServerPowerStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';
import {
  powerWordToServerPowerStatus,
  serverLifecycleToSlug,
  serverPowerStatusToLegacy,
  statusSlugToServerLifecycle,
} from '../device-status-utils';

describe('powerWordToServerPowerStatus', () => {
  it('maps each power word to the typed ServerPowerStatus, including transitional states', () => {
    expect(powerWordToServerPowerStatus('Running')).toBe(ServerPowerStatus.On);
    expect(powerWordToServerPowerStatus('Powered Off')).toBe(ServerPowerStatus.Off);
    expect(powerWordToServerPowerStatus('Starting')).toBe(ServerPowerStatus.PoweringOn);
    expect(powerWordToServerPowerStatus('Shutting Down')).toBe(ServerPowerStatus.PoweringOff);
    expect(powerWordToServerPowerStatus('Rebooting')).toBe(ServerPowerStatus.Rebooting);
  });

  it('returns null for absent or unmapped values', () => {
    expect(powerWordToServerPowerStatus(undefined)).toBeNull();
    expect(powerWordToServerPowerStatus(null)).toBeNull();
    expect(powerWordToServerPowerStatus('')).toBeNull();
    expect(powerWordToServerPowerStatus('On')).toBeNull();
    expect(powerWordToServerPowerStatus('garbage')).toBeNull();
    expect(powerWordToServerPowerStatus(42)).toBeNull();
  });
});

describe('serverPowerStatusToLegacy', () => {
  it('maps each ServerPowerStatus to its legacy display word', () => {
    expect(serverPowerStatusToLegacy(ServerPowerStatus.On)).toBe('Running');
    expect(serverPowerStatusToLegacy(ServerPowerStatus.Off)).toBe('Powered Off');
    expect(serverPowerStatusToLegacy(ServerPowerStatus.PoweringOn)).toBe('Starting');
    expect(serverPowerStatusToLegacy(ServerPowerStatus.PoweringOff)).toBe('Shutting Down');
    expect(serverPowerStatusToLegacy(ServerPowerStatus.Rebooting)).toBe('Rebooting');
  });

  it('round-trips with powerWordToServerPowerStatus', () => {
    for (const ps of Object.values(ServerPowerStatus)) {
      expect(powerWordToServerPowerStatus(serverPowerStatusToLegacy(ps))).toBe(ps);
    }
  });

  it('returns null for null/undefined', () => {
    expect(serverPowerStatusToLegacy(null)).toBeNull();
    expect(serverPowerStatusToLegacy(undefined)).toBeNull();
  });
});

describe('statusSlugToServerLifecycle', () => {
  it('maps every known NetBox slug (case-insensitively) to a ServerLifecycleStatus', () => {
    expect(statusSlugToServerLifecycle('inventory')).toBe(ServerLifecycleStatus.INVENTORY);
    expect(statusSlugToServerLifecycle('planned')).toBe(ServerLifecycleStatus.INVENTORY);
    expect(statusSlugToServerLifecycle('provisioning')).toBe(ServerLifecycleStatus.PROVISIONING);
    expect(statusSlugToServerLifecycle('staged')).toBe(ServerLifecycleStatus.PROVISIONING);
    expect(statusSlugToServerLifecycle('provisioned')).toBe(ServerLifecycleStatus.PROVISIONED);
    expect(statusSlugToServerLifecycle('active')).toBe(ServerLifecycleStatus.PROVISIONED);
    expect(statusSlugToServerLifecycle('offline')).toBe(ServerLifecycleStatus.OFFLINE);
    expect(statusSlugToServerLifecycle('maintenance')).toBe(ServerLifecycleStatus.OFFLINE);
    expect(statusSlugToServerLifecycle('failed')).toBe(ServerLifecycleStatus.FAILED);
    expect(statusSlugToServerLifecycle('deprovisioning')).toBe(ServerLifecycleStatus.DEPROVISIONING);
  });

  it('is case-insensitive on the input slug', () => {
    expect(statusSlugToServerLifecycle('PROVISIONED')).toBe(ServerLifecycleStatus.PROVISIONED);
    expect(statusSlugToServerLifecycle('Inventory')).toBe(ServerLifecycleStatus.INVENTORY);
  });

  it('throws on an unknown slug', () => {
    expect(() => statusSlugToServerLifecycle('bogus')).toThrow(/Unknown server lifecycle status/);
    expect(() => statusSlugToServerLifecycle('')).toThrow(/Unknown server lifecycle status/);
  });
});

describe('serverLifecycleToSlug', () => {
  it('maps each lifecycle status to its NetBox slug', () => {
    expect(serverLifecycleToSlug(ServerLifecycleStatus.INVENTORY)).toBe('inventory');
    expect(serverLifecycleToSlug(ServerLifecycleStatus.PROVISIONING)).toBe('provisioning');
    expect(serverLifecycleToSlug(ServerLifecycleStatus.PROVISIONED)).toBe('provisioned');
    expect(serverLifecycleToSlug(ServerLifecycleStatus.OFFLINE)).toBe('offline');
    expect(serverLifecycleToSlug(ServerLifecycleStatus.FAILED)).toBe('failed');
    expect(serverLifecycleToSlug(ServerLifecycleStatus.DEPROVISIONING)).toBe('deprovisioning');
  });

  it('round-trips back through statusSlugToServerLifecycle', () => {
    for (const status of Object.values(ServerLifecycleStatus)) {
      expect(statusSlugToServerLifecycle(serverLifecycleToSlug(status))).toBe(status);
    }
  });
});
