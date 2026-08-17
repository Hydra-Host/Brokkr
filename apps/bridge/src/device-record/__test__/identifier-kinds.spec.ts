import { describe, expect, it } from 'vitest';

import { MAC_KINDS, isHardwarePlaceholder, isLocallyAdministeredMac } from '../identifier-kinds';

describe('MAC_KINDS', () => {
  it('contains mac and ipmi_mac', () => {
    expect([...MAC_KINDS].sort()).toEqual(['ipmi_mac', 'mac']);
  });
});

describe('isLocallyAdministeredMac', () => {
  it('burned-in OUI is not locally administered', () => {
    expect(isLocallyAdministeredMac('7c:c2:55:92:02:9c')).toBe(false);
  });

  it('USB management NIC is locally administered', () => {
    expect(isLocallyAdministeredMac('be:3a:f2:b6:05:9f')).toBe(true);
  });

  it('handles hyphen-separated form', () => {
    expect(isLocallyAdministeredMac('BE-3A-F2-B6-05-9F')).toBe(true);
  });

  it.each([
    ['02', true],
    ['06', true],
    ['0a', true],
    ['0e', true],
    ['00', false],
    ['0c', false],
    ['3c', false],
  ])('first octet %s → %s', (octet, expected) => {
    expect(isLocallyAdministeredMac(`${octet}:11:22:33:44:55`)).toBe(expected);
  });

  it('malformed value is treated as usable (no throw)', () => {
    expect(isLocallyAdministeredMac('not-a-mac')).toBe(false);
    expect(isLocallyAdministeredMac('')).toBe(false);
  });
});

describe('isHardwarePlaceholder', () => {
  it.each([
    '',
    '   ',
    'To Be Filled By O.E.M.',
    'Default string',
    'Not Applicable',
    'Not Specified',
    'Unknown',
    'None',
    '0',
    '00000000',
    '01234567890123456789AB',
    'System Serial Number',
    'System Manufacturer',
    'Free Form Asset Tag',
    'Chassis Asset Tag',
    'NA',
    'n/a',
  ])('flags %j as placeholder', (value) => {
    expect(isHardwarePlaceholder(value)).toBe(true);
  });

  it.each(['Dell Inc.', 'SN-ABC-123', 'aa:bb:cc:dd:ee:ff', '550e8400-e29b-41d4-a716-446655440000'])(
    'treats %j as a real identifier',
    (value) => {
      expect(isHardwarePlaceholder(value)).toBe(false);
    },
  );
});
