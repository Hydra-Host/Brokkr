import { describe, expect, it } from 'vitest';
import { type DeviceInterfaceRow, toInterfaceResponse } from '../interface-response.utils';

describe('toInterfaceResponse', () => {
  const baseRow: DeviceInterfaceRow = {
    name: 'eth0',
    type: 'ETHERNET_25G',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    markConnected: true,
    enabled: true,
    mgmtOnly: false,
    ipAddresses: [{ id: 'ip-1', address: '10.0.0.5/24' }],
  };

  it('strips sensitive IP fields', () => {
    const ipWithExtras = {
      id: 'ip-1',
      address: '10.0.0.5/24',
      organizationId: 'org-secret',
      vrfId: 'vrf-secret',
      assignedObjectId: 'obj-secret',
    } as DeviceInterfaceRow['ipAddresses'][number];

    const row: DeviceInterfaceRow = { ...baseRow, ipAddresses: [ipWithExtras] };
    const out = toInterfaceResponse(row);

    expect(Object.keys(out.ip_addresses[0])).toEqual(['id', 'address']);
  });

  it('maps base fields + coerces null macAddress to ""', () => {
    const row: DeviceInterfaceRow = {
      name: 'bond0',
      type: 'BOND',
      macAddress: null,
      markConnected: false,
      enabled: false,
      mgmtOnly: true,
      ipAddresses: [],
    };
    const out = toInterfaceResponse(row);

    expect(out.mac_address).toBe('');
    expect(out.name).toBe('bond0');
    expect(out.type).toBe('BOND');
    expect(out.mark_connected).toBe(false);
    expect(out.enabled).toBe(false);
    expect(out.mgmt_only).toBe(true);
  });
});
