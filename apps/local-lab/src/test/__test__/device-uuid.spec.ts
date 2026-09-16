import { describe, expect, it } from 'vitest';

import { bmDeviceUuid, simDeviceUuid } from '../../common/hub-client';

describe('device-uuid derivation (lockstep with local-sim + hub seed)', () => {
  describe('bmDeviceUuid', () => {
    it('reproduces the local-sim uuid5 for the bench MAC', () => {
      expect(bmDeviceUuid('00:00:5e:00:53:b4')).toBe('0e8c9981-6781-5e20-9d8e-a84ccf7f548a');
    });

    it('lowercases the MAC before hashing (case-insensitive identity)', () => {
      expect(bmDeviceUuid('00:00:5E:00:53:B4')).toBe(bmDeviceUuid('00:00:5e:00:53:b4'));
    });

    it('is distinct from the index-based simDeviceUuid scheme', () => {
      expect(bmDeviceUuid('00:00:5e:00:53:b4')).not.toBe(simDeviceUuid(0));
    });
  });

  describe('simDeviceUuid', () => {
    it('maps flat index → "00000000-…-{index+1:012d}"', () => {
      expect(simDeviceUuid(0)).toBe('00000000-0000-0000-0000-000000000001');
      expect(simDeviceUuid(3)).toBe('00000000-0000-0000-0000-000000000004');
    });
  });
});
