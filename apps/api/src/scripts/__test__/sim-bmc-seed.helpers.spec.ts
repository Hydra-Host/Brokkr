import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ZoneCryptoRepository } from '../../zone-crypto/zone-crypto.repository';
import {
  bmDeviceUuid,
  ENROLLMENT_POLL_ATTEMPTS,
  parseBaremetalNodes,
  parseFleetPlanes,
  parseFleetYaml,
  readBmc,
  simDeviceUuid,
  waitForEnrollment,
} from '../sim-bmc-seed.helpers';

const VM_ROSTER = 'nodes:\n  - name: cpu-1\n    ipmi_mac: "52:54:00:bc:00:01"\n';
const BM_BLOCK = `baremetal:
  iface: enp35s0
  arch: amd64
  nodes:
    - name: bench-1
      pxe_mac: "00:00:5e:00:53:b4"
      bmc_mac: "00:00:5e:00:53:b5"
      bmc_ip: 198.51.100.250
`;
const EMPTY_BM_BLOCK = 'baremetal:\n  iface: enp35s0\n  nodes: []\n';

describe('sim-bmc-seed helpers', () => {
  describe('simDeviceUuid', () => {
    it('maps flat index → "00000000-…-{index+1:012d}"', () => {
      expect(simDeviceUuid(0)).toBe('00000000-0000-0000-0000-000000000001');
      expect(simDeviceUuid(3)).toBe('00000000-0000-0000-0000-000000000004');
      expect(simDeviceUuid(11)).toBe('00000000-0000-0000-0000-000000000012');
    });
  });

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

  describe('parseFleetPlanes', () => {
    it('reads a vm-only fleet as the vm plane alone', () => {
      expect(parseFleetPlanes(VM_ROSTER)).toEqual({ vm: true, baremetal: false });
    });

    it('reads a bare-metal-only fleet as the bare-metal plane alone', () => {
      expect(parseFleetPlanes(`nodes: []\n${BM_BLOCK}`)).toEqual({ vm: false, baremetal: true });
    });

    it('reads both planes when a machine sits beside the vm roster', () => {
      expect(parseFleetPlanes(`${VM_ROSTER}${BM_BLOCK}`)).toEqual({ vm: true, baremetal: true });
    });

    it('reads an empty roster as a plane that is off', () => {
      expect(parseFleetPlanes(`nodes: []\n${EMPTY_BM_BLOCK}`)).toEqual({ vm: false, baremetal: false });
      expect(parseFleetPlanes('network:\n  name: x\n')).toEqual({ vm: false, baremetal: false });
    });

    it('ignores a stale mode key', () => {
      expect(parseFleetPlanes(`mode: baremetal\n${VM_ROSTER}`)).toEqual({ vm: true, baremetal: false });
    });

    it('throws when the doc is not an object', () => {
      expect(() => parseFleetPlanes('just-a-scalar\n')).toThrow(/object/);
    });
  });

  describe('parseBaremetalNodes', () => {
    it('returns name + pxeMac for each baremetal node', () => {
      expect(parseBaremetalNodes(BM_BLOCK)).toEqual([{ name: 'bench-1', pxeMac: '00:00:5e:00:53:b4' }]);
    });

    it('returns the machines beside a vm roster', () => {
      expect(parseBaremetalNodes(`${VM_ROSTER}${BM_BLOCK}`)).toEqual([
        { name: 'bench-1', pxeMac: '00:00:5e:00:53:b4' },
      ]);
    });

    it('returns [] when the block is absent or carries no machines', () => {
      expect(parseBaremetalNodes(VM_ROSTER)).toEqual([]);
      expect(parseBaremetalNodes(`${VM_ROSTER}${EMPTY_BM_BLOCK}`)).toEqual([]);
    });

    it('throws on a baremetal node missing name/pxe_mac', () => {
      expect(() => parseBaremetalNodes('baremetal:\n  nodes:\n    - {bmc_ip: 1.2.3.4}\n')).toThrow(/name \+ pxe_mac/);
    });
  });

  describe('readBmc precedence', () => {
    const defaults = { user: 'admin', pass: 'admin' };

    it('falls back to defaults when the block is absent/non-object', () => {
      expect(readBmc(undefined, defaults)).toEqual(defaults);
      expect(readBmc(null, defaults)).toEqual(defaults);
      expect(readBmc('nope', defaults)).toEqual(defaults);
    });

    it('reads schema.py BmcConfig field names (username/password)', () => {
      expect(readBmc({ username: 'root', password: 'calvin' }, defaults)).toEqual({ user: 'root', pass: 'calvin' });
    });

    it('per-field fallback to defaults when one side is missing/empty', () => {
      expect(readBmc({ username: 'root' }, defaults)).toEqual({ user: 'root', pass: 'admin' });
      expect(readBmc({ username: '', password: 'x' }, defaults)).toEqual({ user: 'admin', pass: 'x' });
    });
  });

  describe('parseFleetYaml', () => {
    const FLEET = `
network:
  name: brokkr-net
  cidr: 192.168.200.0/24
  bmc_cidr: 192.168.105.0/24
defaults:
  bmc:
    username: admin
    password: admin
nodes:
  - name: cpu-1
    ipmi_mac: "52:54:00:bc:00:01"
  - name: cpu-2
    ipmi_mac: "52:54:00:bc:00:02"
    bmc:
      username: operator
      password: s3cret
`;

    it('flattens nodes with index, name, and effective BMC creds (per-node over defaults)', () => {
      const nodes = parseFleetYaml(FLEET);
      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toMatchObject({ index: 0, name: 'cpu-1', bmc: { user: 'admin', pass: 'admin' } });
      expect(nodes[1]).toMatchObject({ index: 1, name: 'cpu-2', bmc: { user: 'operator', pass: 's3cret' } });
    });

    it('defaults to admin/admin when no defaults.bmc block exists', () => {
      const nodes = parseFleetYaml('nodes:\n  - name: cpu-1\n');
      expect(nodes[0].bmc).toEqual({ user: 'admin', pass: 'admin' });
    });

    it('carries the per-node zone name when present (multi-zone), undefined otherwise', () => {
      const nodes = parseFleetYaml('nodes:\n  - name: a\n    zone: sim-zone-1\n  - name: b\n');
      expect(nodes[0].zoneName).toBe('sim-zone-1');
      expect(nodes[1].zoneName).toBeUndefined();
    });

    it('throws on a doc that is not an object or has no nodes', () => {
      expect(() => parseFleetYaml('just-a-scalar\n')).toThrow(/object/);
      expect(() => parseFleetYaml('network:\n  name: x\n')).toThrow(/no nodes/);
      expect(() => parseFleetYaml('nodes: []\n')).toThrow(/no nodes/);
    });
  });

  describe('waitForEnrollment', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const makeRepo = () => {
      const findEnrollmentByZoneId = vi.fn();
      const repo = { findEnrollmentByZoneId } as unknown as ZoneCryptoRepository;
      return { repo, findEnrollmentByZoneId };
    };

    it('resolves true on the first enrolled poll (non-empty zonePub), no sleep', async () => {
      const { repo, findEnrollmentByZoneId } = makeRepo();
      findEnrollmentByZoneId.mockResolvedValue({ zonePub: new Uint8Array([1]) });
      await expect(waitForEnrollment(repo, 'zone-1')).resolves.toBe(true);
      expect(findEnrollmentByZoneId).toHaveBeenCalledTimes(1);
    });

    it('polls past null/empty rows, then resolves true once zonePub is present', async () => {
      const { repo, findEnrollmentByZoneId } = makeRepo();
      findEnrollmentByZoneId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ zonePub: new Uint8Array() })
        .mockResolvedValue({ zonePub: new Uint8Array([1]) });
      const p = waitForEnrollment(repo, 'zone-1');
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBe(true);
      expect(findEnrollmentByZoneId).toHaveBeenCalledTimes(3);
    });

    it('resolves false after ENROLLMENT_POLL_ATTEMPTS when never enrolled', async () => {
      const { repo, findEnrollmentByZoneId } = makeRepo();
      findEnrollmentByZoneId.mockResolvedValue(null);
      const p = waitForEnrollment(repo, 'zone-1');
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBe(false);
      expect(findEnrollmentByZoneId).toHaveBeenCalledTimes(ENROLLMENT_POLL_ATTEMPTS);
    });
  });
});
