import { describe, expect, it } from 'vitest';

import { bmcCredentials } from '../../../common/bmc.types';
import {
  GpuLayout,
  RecordedProbeClient,
  RedfishDeviceVendorHints,
  defaultVendorHints,
  extractChassisMemberIds,
  identifyVendor,
  memberCount,
  pickBaselineChassisId,
  pickHgxChassisIds,
} from '../redfish-device-vendor-hints';

const CREDS = bmcCredentials('10.0.0.1', 'u', 'p');

describe('memberCount', () => {
  it('uses Members@odata.count when integer', () => {
    expect(memberCount({ 'Members@odata.count': 8, Members: [] })).toBe(8);
  });

  it('falls back to Members length when count missing', () => {
    expect(memberCount({ Members: [{}, {}, {}] })).toBe(3);
  });

  it('falls back to length when count is non-integer', () => {
    expect(memberCount({ 'Members@odata.count': 'lots', Members: [{}, {}] })).toBe(2);
  });

  it('returns 0 when absent or malformed', () => {
    expect(memberCount({})).toBe(0);
    expect(memberCount({ Members: 'nope' })).toBe(0);
  });
});

describe('extractChassisMemberIds', () => {
  it('skips non-dict members', () => {
    const coll = {
      Members: [
        { '@odata.id': '/redfish/v1/Chassis/1' },
        'bogus',
        null,
        { '@odata.id': '/redfish/v1/Chassis/HGX_GPU_0/' },
      ],
    };
    expect(extractChassisMemberIds(coll)).toEqual(['1', 'HGX_GPU_0']);
  });

  it('strips url prefix and trailing slash', () => {
    const coll = {
      Members: [
        { '@odata.id': '/redfish/v1/Chassis/1' },
        { '@odata.id': '/redfish/v1/Chassis/HGX_GPU_0' },
        { '@odata.id': '/redfish/v1/Chassis/HGX_GPU_SXM_1/' },
      ],
    };
    expect(extractChassisMemberIds(coll)).toEqual(['1', 'HGX_GPU_0', 'HGX_GPU_SXM_1']);
  });
});

describe('identifyVendor', () => {
  it.each<[Record<string, unknown>, string]>([
    [{ Vendor: 'Dell' }, 'dell'],
    [{ Vendor: 'Lenovo' }, 'lenovo'],
    [{ Vendor: 'Supermicro' }, 'supermicro'],
    [{ Vendor: 'Cisco Systems Inc' }, 'cisco'],
    [{ Vendor: null, Oem: { Hp: {} } }, 'hp'],
    [{ Vendor: null, Oem: { Public: { Manufacturer: 'AIVRES' } } }, 'aivres'],
    [{ Vendor: null, Oem: {} }, ''],
  ])('%j → %s', (root, expected) => {
    expect(identifyVendor(root).vendor).toBe(expected);
  });

  it('handles null manufacturer', () => {
    expect(identifyVendor({ Vendor: null, Oem: { Public: { Manufacturer: null } } }).vendor).toBe('');
  });
});

describe('pickBaselineChassisId', () => {
  it('picks "1" when present', () => {
    expect(pickBaselineChassisId(['1', 'HGX_GPU_0', 'HGX_GPU_1'])).toBe('1');
  });

  it('Dell style', () => {
    expect(pickBaselineChassisId(['System.Embedded.1', 'Enclosure.Internal.0-1'])).toBe('System.Embedded.1');
  });

  it('Cisco style', () => {
    expect(pickBaselineChassisId(['chassis', 'GPU_1', 'GPU_2'])).toBe('chassis');
  });

  it('AMI Self', () => {
    expect(pickBaselineChassisId(['Self', 'HGX_GPU_SXM_1'])).toBe('Self');
  });

  it('priority order: "1" wins', () => {
    expect(pickBaselineChassisId(['chassis', '1'])).toBe('1');
  });

  it('falls back to "1" when nothing matches', () => {
    expect(pickBaselineChassisId(['MainChassis', 'GPU_Sled'])).toBe('1');
  });
});

describe('pickHgxChassisIds', () => {
  it('plain only', () => {
    expect(pickHgxChassisIds(['HGX_GPU_0', 'HGX_GPU_1', 'HGX_GPU_2', '1'])).toEqual([
      'HGX_GPU_0',
      'HGX_GPU_1',
      'HGX_GPU_2',
    ]);
  });

  it('sxm only', () => {
    expect(pickHgxChassisIds(['HGX_GPU_SXM_1', 'HGX_GPU_SXM_2', '1'])).toEqual(['HGX_GPU_SXM_1', 'HGX_GPU_SXM_2']);
  });

  it('both forms prefers plain', () => {
    const memberIds = [
      ...Array.from({ length: 8 }, (_, n) => `HGX_GPU_${n}`),
      ...Array.from({ length: 8 }, (_, n) => `HGX_GPU_SXM_${n + 1}`),
      '1',
    ];
    const result = pickHgxChassisIds(memberIds);
    expect(result).toEqual(Array.from({ length: 8 }, (_, n) => `HGX_GPU_${n}`));
    expect(result.some((c) => c.includes('SXM'))).toBe(false);
  });

  it('neither returns empty', () => {
    expect(pickHgxChassisIds(['1', 'Self', 'DC_SCM'])).toEqual([]);
  });
});

describe('RedfishDeviceVendorHints failure modes', () => {
  it('unreachable root returns defaults', async () => {
    const probe = new RecordedProbeClient({});
    const d = new RedfishDeviceVendorHints(probe);
    expect(await d.get('d1', CREDS)).toEqual(defaultVendorHints());
  });

  it('unknown vendor falls back gracefully', async () => {
    const probe = new RecordedProbeClient({
      '/redfish/v1/': { Vendor: 'FutureBmcCo', RedfishVersion: '1.99.0' },
      '/redfish/v1/Chassis': { Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }] },
    });
    const d = new RedfishDeviceVendorHints(probe);
    const hints = await d.get('d1', CREDS);
    expect(hints.baselineChassisId).toBe('1');
    expect(hints.gpuLayout).toBe(GpuLayout.NONE);
  });
});

describe('RecordedProbeClient', () => {
  it('records calls', async () => {
    const probe = new RecordedProbeClient({ '/x': { y: 1 } });
    await probe.get('1.1.1.1', '/x', { username: 'u', password: 'p' });
    expect(probe.calls).toEqual(['/x']);
  });

  it('rejects password if configured', async () => {
    const probe = new RecordedProbeClient({ '/x': { y: 1 } }, { rejectAuthForPassword: 'rotated' });
    const result = await probe.get('1.1.1.1', '/x', { username: 'u', password: 'rotated' });
    expect(result).toBeNull();
    expect(probe.authRejected).toBe(true);
  });

  it('resetAuth clears the flag', () => {
    const probe = new RecordedProbeClient({});
    probe.authRejected = true;
    probe.resetAuth();
    expect(probe.authRejected).toBe(false);
  });

  it('empty body recording surfaces as null', async () => {
    const probe = new RecordedProbeClient({ '/x': {} });
    const result = await probe.get('1.1.1.1', '/x', { username: 'u', password: 'p' });
    expect(result).toBeNull();
  });
});
