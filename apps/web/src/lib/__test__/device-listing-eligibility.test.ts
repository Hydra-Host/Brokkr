import type { ServerPriceFormServer } from '@repo/ui/form/server-price-form';
import { isServerNotAvailableToList } from '@repo/ui/form/server-price-form';
import { describe, expect, it } from 'vitest';

function stubDevice(overrides: {
  baseLayers?: { slug: string; name: string }[];
  networking?: { ipv4?: string | null; ipv6?: string | null; vpcCapable?: boolean | null };
}): ServerPriceFormServer {
  return {
    specs: { gpu: { model: null, count: null }, cpu: { model: null, count: null } },
    listing: {
      isActive: false,
      isInterruptibleOnly: false,
      onDemandPrice: { perHour: { total: null } },
      interruptiblePrice: { perHour: { total: null } },
    },
    availableBaseLayers: overrides.baseLayers ?? [{ slug: 'ubuntu-noble', name: 'Ubuntu 24.04' }],
    networking: {
      ipv4: '10.0.0.1',
      ipv6: null,
      vpcCapable: false,
      ...overrides.networking,
    },
  };
}

describe('isServerNotAvailableToList', () => {
  it('returns true when availableBaseLayers is empty', () => {
    const device = stubDevice({ baseLayers: [] });
    expect(isServerNotAvailableToList(device)).toBe(true);
  });

  it('returns true when device has no networking (no ipv4, ipv6, or vpc)', () => {
    const device = stubDevice({ networking: { ipv4: null, ipv6: null, vpcCapable: false } });
    expect(isServerNotAvailableToList(device)).toBe(true);
  });

  it('returns false when device has base layers and ipv4', () => {
    const device = stubDevice({});
    expect(isServerNotAvailableToList(device)).toBe(false);
  });

  it('returns false when device has base layers and ipv6 only', () => {
    const device = stubDevice({ networking: { ipv4: null, ipv6: '::1', vpcCapable: false } });
    expect(isServerNotAvailableToList(device)).toBe(false);
  });

  it('returns false when device has base layers and vpc only', () => {
    const device = stubDevice({ networking: { ipv4: null, ipv6: null, vpcCapable: true } });
    expect(isServerNotAvailableToList(device)).toBe(false);
  });
});
