import { type DeviceInterfaceWithIps, INTERFACE_NAME_MESSAGE } from '@repo/api-client';
import { describe, expect, it } from 'vitest';

import {
  type Draft,
  type NewRow,
  NONE,
  blankNewRow,
  buildPatch,
  fieldErrors,
  formatSpeed,
  isActiveNewRow,
  normMac,
  parseIntOrNull,
  toDraft,
  validateEdits,
} from './device-interfaces.utils';

function makeIface(overrides: Partial<DeviceInterfaceWithIps> & { id: string; name: string }): DeviceInterfaceWithIps {
  return {
    type: null,
    enabled: true,
    mtu: null,
    macAddress: null,
    speed: null,
    mgmtOnly: false,
    markConnected: false,
    mode: null,
    description: null,
    linkType: null,
    guid: null,
    portState: null,
    maxSpeedGbps: null,
    pciDeviceId: null,
    lldpNeighborName: null,
    lldpNeighborPort: null,
    lldpNeighborDescr: null,
    lldpNeighborMgmtIp: null,
    deviceId: '00000000-0000-0000-0000-000000000001',
    lagId: null,
    parentId: null,
    untaggedVlanId: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ipAddresses: [],
    ...overrides,
  };
}

describe('parseIntOrNull', () => {
  it('returns null for empty string', () => {
    expect(parseIntOrNull('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(parseIntOrNull('   ')).toBeNull();
  });

  it('parses a valid integer', () => {
    expect(parseIntOrNull('1500')).toBe(1500);
  });

  it('parses with leading/trailing whitespace', () => {
    expect(parseIntOrNull('  42  ')).toBe(42);
  });

  it('returns null for non-numeric text', () => {
    expect(parseIntOrNull('abc')).toBeNull();
  });

  it('truncates decimal portion (parseInt semantics)', () => {
    expect(parseIntOrNull('9.7')).toBe(9);
  });
});

describe('normMac', () => {
  it('lowercases and strips colons', () => {
    expect(normMac('AA:BB:CC:DD:EE:FF')).toBe('aabbccddeeff');
  });

  it('strips dashes', () => {
    expect(normMac('aa-bb-cc-dd-ee-ff')).toBe('aabbccddeeff');
  });

  it('strips dots', () => {
    expect(normMac('aabb.ccdd.eeff')).toBe('aabbccddeeff');
  });

  it('trims whitespace', () => {
    expect(normMac('  aa:bb:cc:dd:ee:ff  ')).toBe('aabbccddeeff');
  });
});

describe('formatSpeed', () => {
  it('returns -- for null', () => {
    expect(formatSpeed(null)).toBe('--');
  });

  it('returns -- for 0', () => {
    expect(formatSpeed(0)).toBe('--');
  });

  it('formats sub-gigabit as Mbps', () => {
    expect(formatSpeed(100)).toBe('100M');
  });

  it('formats gigabit and above as Gbps', () => {
    expect(formatSpeed(1000)).toBe('1G');
    expect(formatSpeed(10000)).toBe('10G');
    expect(formatSpeed(25000)).toBe('25G');
  });
});

describe('toDraft', () => {
  it('maps interface fields to draft strings', () => {
    const iface = makeIface({
      id: 'a',
      name: 'eth0',
      type: 'ETHERNET_10G',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      speed: 10000,
      mtu: 9000,
      enabled: false,
      markConnected: true,
    });
    const d = toDraft(iface);
    expect(d).toEqual({
      name: 'eth0',
      type: 'ETHERNET_10G',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      speed: '10000',
      mtu: '9000',
      enabled: false,
      markConnected: true,
    });
  });

  it('uses NONE sentinel for null type', () => {
    const iface = makeIface({ id: 'b', name: 'eth1', type: null });
    expect(toDraft(iface).type).toBe(NONE);
  });

  it('uses empty string for null mac/speed/mtu', () => {
    const iface = makeIface({ id: 'c', name: 'eth2', macAddress: null, speed: null, mtu: null });
    const d = toDraft(iface);
    expect(d.macAddress).toBe('');
    expect(d.speed).toBe('');
    expect(d.mtu).toBe('');
  });
});

describe('isActiveNewRow', () => {
  const blank: NewRow = {
    tempId: 'new-0',
    name: '',
    type: NONE,
    macAddress: '',
    speed: '',
    mtu: '',
    enabled: true,
    markConnected: false,
  };

  it('returns false for a completely blank row', () => {
    expect(isActiveNewRow(blank)).toBe(false);
  });

  it('returns true if name is set', () => {
    expect(isActiveNewRow({ ...blank, name: 'eth0' })).toBe(true);
  });

  it('returns true if macAddress is set', () => {
    expect(isActiveNewRow({ ...blank, macAddress: 'aa:bb:cc:dd:ee:ff' })).toBe(true);
  });

  it('returns true if speed is set', () => {
    expect(isActiveNewRow({ ...blank, speed: '1000' })).toBe(true);
  });

  it('returns true if mtu is set', () => {
    expect(isActiveNewRow({ ...blank, mtu: '9000' })).toBe(true);
  });

  it('ignores whitespace-only fields', () => {
    expect(isActiveNewRow({ ...blank, name: '   ' })).toBe(false);
  });
});

describe('blankNewRow', () => {
  it('creates a row with a unique tempId', () => {
    const a = blankNewRow();
    const b = blankNewRow();
    expect(a.tempId).not.toBe(b.tempId);
    expect(a.tempId).toMatch(/^new-\d+$/);
  });

  it('starts with all fields empty/default', () => {
    const r = blankNewRow();
    expect(r.name).toBe('');
    expect(r.type).toBe(NONE);
    expect(r.macAddress).toBe('');
    expect(r.speed).toBe('');
    expect(r.mtu).toBe('');
    expect(r.enabled).toBe(true);
    expect(r.markConnected).toBe(false);
  });
});

describe('fieldErrors', () => {
  const noNames = new Map<string, number>();
  const noMacs = new Map<string, number>();

  it('requires a name', () => {
    const e = fieldErrors('', '', '', '', noNames, noMacs);
    expect(e.name).toBe('Name is required');
  });

  it('detects duplicate name', () => {
    const names = new Map([['eth0', 2]]);
    const e = fieldErrors('eth0', '', '', '', names, noMacs);
    expect(e.name).toBe('Duplicate name');
  });

  it('detects invalid MAC address', () => {
    const e = fieldErrors('eth0', 'not-a-mac', '', '', noNames, noMacs);
    expect(e.macAddress).toBe('Invalid MAC address');
  });

  it('detects duplicate MAC', () => {
    const macs = new Map([['aabbccddeeff', 2]]);
    const e = fieldErrors('eth0', 'aa:bb:cc:dd:ee:ff', '', '', noNames, macs);
    expect(e.macAddress).toBe('Duplicate MAC');
  });

  it('detects invalid speed', () => {
    const e = fieldErrors('eth0', '', 'abc', '', noNames, noMacs);
    expect(e.speed).toBe('Invalid number');
  });

  it('detects negative speed', () => {
    const e = fieldErrors('eth0', '', '-1', '', noNames, noMacs);
    expect(e.speed).toBe('Invalid number');
  });

  it('detects invalid mtu', () => {
    const e = fieldErrors('eth0', '', '', 'xyz', noNames, noMacs);
    expect(e.mtu).toBe('Invalid number');
  });

  it('detects negative mtu', () => {
    const e = fieldErrors('eth0', '', '', '-5', noNames, noMacs);
    expect(e.mtu).toBe('Invalid number');
  });

  it('returns empty object for a fully valid row', () => {
    const names = new Map([['eth0', 1]]);
    const macs = new Map([['aabbccddeeff', 1]]);
    const e = fieldErrors('eth0', 'aa:bb:cc:dd:ee:ff', '1000', '9000', names, macs);
    expect(e).toEqual({});
  });

  it('accepts empty MAC (optional field)', () => {
    const e = fieldErrors('eth0', '', '', '', new Map([['eth0', 1]]), noMacs);
    expect(e.macAddress).toBeUndefined();
  });

  it('accepts a valid single-character name', () => {
    expect(fieldErrors('a', '', '', '', noNames, noMacs).name).toBeUndefined();
  });

  it('accepts a valid 15-character name (on-boundary)', () => {
    expect(fieldErrors('a'.repeat(15), '', '', '', noNames, noMacs).name).toBeUndefined();
  });

  it('rejects a 16-character name (over-boundary)', () => {
    expect(fieldErrors('a'.repeat(16), '', '', '', noNames, noMacs).name).toBe(INTERFACE_NAME_MESSAGE);
  });

  it('rejects a name starting with a hyphen', () => {
    expect(fieldErrors('-eth0', '', '', '', noNames, noMacs).name).toBe(INTERFACE_NAME_MESSAGE);
  });

  it('rejects a name with a disallowed special character', () => {
    expect(fieldErrors('eth!0', '', '', '', noNames, noMacs).name).toBe(INTERFACE_NAME_MESSAGE);
  });

  it('accepts names using the allowed special characters (. _ @ : -)', () => {
    for (const name of ['eth.0', 'eth_0', 'eth@0', 'eth:0', 'eth-0']) {
      expect(fieldErrors(name, '', '', '', noNames, noMacs).name).toBeUndefined();
    }
  });
});

describe('validateEdits', () => {
  const ifA = makeIface({ id: 'a', name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:01' });
  const ifB = makeIface({ id: 'b', name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:02' });
  const allInterfaces = [ifA, ifB];

  it('returns hasErrors:false for a clean session', () => {
    const drafts: Record<string, Draft> = {
      a: toDraft(ifA),
      b: toDraft(ifB),
    };
    const result = validateEdits({
      interfaces: allInterfaces,
      allInterfaces,
      drafts,
      newRows: [],
      markedDelete: new Set(),
    });
    expect(result.hasErrors).toBe(false);
    expect(result.byId).toEqual({});
    expect(result.byTempId).toEqual({});
  });

  it('detects a duplicate name across existing interfaces', () => {
    const drafts: Record<string, Draft> = {
      a: { ...toDraft(ifA), name: 'eth1' },
      b: toDraft(ifB),
    };
    const result = validateEdits({
      interfaces: allInterfaces,
      allInterfaces,
      drafts,
      newRows: [],
      markedDelete: new Set(),
    });
    expect(result.hasErrors).toBe(true);
    expect(result.byId['a']?.name).toBe('Duplicate name');
    expect(result.byId['b']?.name).toBe('Duplicate name');
  });

  it('ignores rows in markedDelete', () => {
    const drafts: Record<string, Draft> = {
      a: { ...toDraft(ifA), name: 'eth1' },
      b: toDraft(ifB),
    };
    const result = validateEdits({
      interfaces: allInterfaces,
      allInterfaces,
      drafts,
      newRows: [],
      markedDelete: new Set(['b']),
    });
    expect(result.hasErrors).toBe(false);
  });

  it('flags a new row colliding with an existing interface name', () => {
    const newRow: NewRow = {
      tempId: 'new-99',
      name: 'eth0',
      type: NONE,
      macAddress: '',
      speed: '',
      mtu: '',
      enabled: true,
      markConnected: false,
    };
    const drafts: Record<string, Draft> = {
      a: toDraft(ifA),
      b: toDraft(ifB),
    };
    const result = validateEdits({
      interfaces: allInterfaces,
      allInterfaces,
      drafts,
      newRows: [newRow],
      markedDelete: new Set(),
    });
    expect(result.hasErrors).toBe(true);
    expect(result.byTempId['new-99']?.name).toBe('Duplicate name');
    expect(result.byId['a']?.name).toBe('Duplicate name');
  });
});

describe('buildPatch', () => {
  const orig = makeIface({
    id: 'x',
    name: 'eth0',
    type: 'ETHERNET_10G',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    speed: 10000,
    mtu: 1500,
    enabled: true,
    markConnected: false,
  });

  it('returns empty patch for unchanged draft', () => {
    const d = toDraft(orig);
    expect(buildPatch(orig, d)).toEqual({});
  });

  it('includes only changed fields', () => {
    const d: Draft = { ...toDraft(orig), name: 'eth99', mtu: '9000' };
    const patch = buildPatch(orig, d);
    expect(patch.name).toBe('eth99');
    expect(patch.mtu).toBe(9000);
    expect(patch).not.toHaveProperty('type');
    expect(patch).not.toHaveProperty('macAddress');
    expect(patch).not.toHaveProperty('speed');
    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('markConnected');
  });

  it('maps NONE type to null', () => {
    const origNoType = makeIface({ id: 'y', name: 'eth0', type: 'ETHERNET_10G' });
    const d: Draft = { ...toDraft(origNoType), type: NONE };
    const patch = buildPatch(origNoType, d);
    expect(patch.type).toBeNull();
  });

  it('clears mac to null when draft is empty string', () => {
    const d: Draft = { ...toDraft(orig), macAddress: '' };
    const patch = buildPatch(orig, d);
    expect(patch.macAddress).toBeNull();
  });

  it('clears speed/mtu to null when draft is blank', () => {
    const d: Draft = { ...toDraft(orig), speed: '', mtu: '' };
    const patch = buildPatch(orig, d);
    expect(patch.speed).toBeNull();
    expect(patch.mtu).toBeNull();
  });

  it('parses numeric strings for speed and mtu', () => {
    const origZero = makeIface({ id: 'z', name: 'eth0', speed: null, mtu: null });
    const d: Draft = { ...toDraft(origZero), speed: '25000', mtu: '9000' };
    const patch = buildPatch(origZero, d);
    expect(patch.speed).toBe(25000);
    expect(patch.mtu).toBe(9000);
  });

  it('detects boolean changes', () => {
    const d: Draft = { ...toDraft(orig), enabled: false, markConnected: true };
    const patch = buildPatch(orig, d);
    expect(patch.enabled).toBe(false);
    expect(patch.markConnected).toBe(true);
  });

  it('trims whitespace from the name before sending (matches fieldErrors + create path)', () => {
    const d: Draft = { ...toDraft(orig), name: '  eth99  ' };
    expect(buildPatch(orig, d).name).toBe('eth99');
  });

  it('treats a whitespace-only name edit as a no-op (trimmed name equals the original)', () => {
    const d: Draft = { ...toDraft(orig), name: '  eth0  ' };
    expect(buildPatch(orig, d)).not.toHaveProperty('name');
  });
});
