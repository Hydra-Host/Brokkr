import { IpStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { InterfacePresenter } from '../interface.presenter';
import type { InterfaceWithIps } from '../interface.record';

const baseRow = {
  id: 'if-1',
  name: 'eth0',
  type: null,
  enabled: true,
  mtu: null,
  macAddress: 'aa:bb:cc:dd:ee:ff',
  speed: null,
  mgmtOnly: false,
  markConnected: true,
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
  driver: null,
  operstate: null,
  linkOperUp: null,
  linkPhysicalUp: null,
  deviceId: 'dev-1',
  lagId: null,
  parentId: null,
  untaggedVlanId: null,
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ipAddresses: [],
} satisfies InterfaceWithIps;

describe('InterfacePresenter.toResponseWithIps', () => {
  it('projects each IP to only id/address/status, stripping any sensitive columns', () => {
    const ipWithExtras = {
      id: 'ip-1',
      address: '10.0.0.5/24',
      status: IpStatus.ACTIVE,
      organizationId: 'org-x',
      vrfId: 'vrf-x',
    } as InterfaceWithIps['ipAddresses'][number];
    const row: InterfaceWithIps = { ...baseRow, ipAddresses: [ipWithExtras] };

    const out = InterfacePresenter.toResponseWithIps(row);

    expect(Object.keys(out.ipAddresses[0])).toEqual(['id', 'address', 'status']);
  });

  it('maps base fields and an empty IP list', () => {
    const out = InterfacePresenter.toResponseWithIps(baseRow);

    expect(out.name).toBe('eth0');
    expect(out.markConnected).toBe(true);
    expect(out.ipAddresses).toEqual([]);
  });
});
