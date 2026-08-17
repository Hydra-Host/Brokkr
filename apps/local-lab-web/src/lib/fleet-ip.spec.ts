import { describe, expect, it } from 'vitest';

import { derivedIp, derivedIpsStale, nodeIpDisplay } from './fleet-ip';

const DATA_CIDR = '192.168.200.0/24';
const BMC_CIDR = '192.168.201.0/24';

describe('derivedIp', () => {
  it('drops the server value when a static override is set', () => {
    expect(derivedIp('192.168.200.50', '192.168.200.50')).toBeNull();
  });

  it('keeps the server value when no override is set', () => {
    expect(derivedIp(null, '192.168.200.11')).toBe('192.168.200.11');
  });

  it('treats an empty override as unset, matching the server truthiness rule', () => {
    expect(derivedIp('', '192.168.200.11')).toBe('192.168.200.11');
  });

  it('stays null when the server could not derive an address', () => {
    expect(derivedIp(null, null)).toBeNull();
  });
});

describe('nodeIpDisplay', () => {
  const cases: {
    name: string;
    override: string | null;
    derived: string | null;
    cidr: string;
    index: number;
    value: string;
    isOverride: boolean;
  }[] = [
    {
      name: 'data override set',
      override: '192.168.200.50',
      derived: null,
      cidr: DATA_CIDR,
      index: 1,
      value: '192.168.200.50',
      isOverride: true,
    },
    {
      name: 'data override cleared with a server value',
      override: null,
      derived: '192.168.200.11',
      cidr: DATA_CIDR,
      index: 1,
      value: '192.168.200.11',
      isOverride: false,
    },
    {
      name: 'data override cleared without a server value',
      override: null,
      derived: null,
      cidr: DATA_CIDR,
      index: 1,
      value: '192.168.200.11',
      isOverride: false,
    },
    {
      name: 'data plane with no cidr',
      override: null,
      derived: null,
      cidr: '',
      index: 1,
      value: '',
      isOverride: false,
    },
    {
      name: 'bmc override set',
      override: '192.168.201.50',
      derived: null,
      cidr: BMC_CIDR,
      index: 2,
      value: '192.168.201.50',
      isOverride: true,
    },
    {
      name: 'bmc override cleared with a server value',
      override: null,
      derived: '192.168.201.12',
      cidr: BMC_CIDR,
      index: 2,
      value: '192.168.201.12',
      isOverride: false,
    },
    {
      name: 'bmc override cleared without a server value',
      override: null,
      derived: null,
      cidr: BMC_CIDR,
      index: 2,
      value: '192.168.201.12',
      isOverride: false,
    },
    {
      name: 'bmc plane with no cidr',
      override: null,
      derived: null,
      cidr: 'not-a-cidr',
      index: 2,
      value: '',
      isOverride: false,
    },
  ];

  it.each(cases)('$name', ({ override, derived, cidr, index, value, isOverride }) => {
    expect(nodeIpDisplay(override, derived, cidr, index)).toEqual({ value, isOverride });
  });
});

describe('clearing a static override', () => {
  it('shows the derived address, not the value just deleted', () => {
    expect(nodeIpDisplay(null, derivedIp('192.168.200.50', '192.168.200.50'), DATA_CIDR, 1)).toEqual({
      value: '192.168.200.11',
      isOverride: false,
    });
  });

  it('shows nothing when there is no cidr to derive from', () => {
    expect(nodeIpDisplay(null, derivedIp('192.168.201.50', '192.168.201.50'), '', 2)).toEqual({
      value: '',
      isOverride: false,
    });
  });

  it('keeps the override styled as an override while it is still set', () => {
    expect(nodeIpDisplay('192.168.200.50', derivedIp('192.168.200.50', '192.168.200.50'), DATA_CIDR, 1)).toEqual({
      value: '192.168.200.50',
      isOverride: true,
    });
  });
});

describe('derivedIpsStale', () => {
  it('is false while the live cidrs still match the ones the form hydrated from', () => {
    expect(
      derivedIpsStale(
        { cidr: '192.168.200.0/24', bmcCidr: '192.168.105.0/24' },
        { cidr: '192.168.200.0/24', bmcCidr: '192.168.105.0/24' },
      ),
    ).toBe(false);
  });

  it('is true when the data cidr moved under an unsaved form', () => {
    expect(
      derivedIpsStale(
        { cidr: '192.168.200.0/24', bmcCidr: '192.168.105.0/24' },
        { cidr: '10.10.0.0/24', bmcCidr: '192.168.105.0/24' },
      ),
    ).toBe(true);
  });

  it('is true when only the bmc cidr moved', () => {
    expect(
      derivedIpsStale(
        { cidr: '192.168.200.0/24', bmcCidr: '192.168.105.0/24' },
        { cidr: '192.168.200.0/24', bmcCidr: '10.20.0.0/24' },
      ),
    ).toBe(true);
  });
});
