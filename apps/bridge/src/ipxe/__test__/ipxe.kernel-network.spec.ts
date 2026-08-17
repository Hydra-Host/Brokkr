import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeIpResolutionService } from '../../bridge-network/bridge-ip-resolution.service';
import { BridgeNetworkModule } from '../../bridge-network/bridge-network.module';
import { ATOM_FETCHER, NetplanAtomService, type AtomFetcher } from '../../bridge-network/netplan-atom.service';
import { RedisService } from '../../common/redis/redis.service';
import { deviceRecordSchema, type DeviceRecord } from '../../device-record/device-record.schema';

import { IPXE_KERNEL_NETWORK_BUILDER, type KernelNetworkBuilder } from '../chain.service';
import { IpxeModule } from '../ipxe.module';

vi.mock('../../logger/logger.service', () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
  logDebug: vi.fn(async () => {}),
  ContextLogger: class {
    info = vi.fn(async () => {});
    warning = vi.fn(async () => {});
    error = vi.fn(async () => {});
    debug = vi.fn(async () => {});
  },
  getLogger: vi.fn(() => ({
    info: vi.fn(async () => {}),
    warning: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
  })),
}));

const DEVICE_UUID = '12121212-1212-1212-1212-121212121212';

const VLAN_BOND_NETPLAN = `
network:
  version: 2
  ethernets:
    eno1:
      match:
        macaddress: "aa:bb:cc:dd:ee:01"
    eno2:
      match:
        macaddress: "aa:bb:cc:dd:ee:02"
  bonds:
    bond0:
      interfaces: [eno1, eno2]
      parameters:
        mode: 802.3ad
  vlans:
    bond0.105:
      id: 105
      link: bond0
      addresses: [10.20.30.40/24]
      routes:
        - to: default
          via: 10.20.30.1
`;

function record(netplan: string | null): DeviceRecord {
  return deviceRecordSchema.parse({
    id: DEVICE_UUID,
    status: 'provisioning',
    role: 'server',
    installed_os: null,
    rescue_os: null,
    platform_tags: [],
    device_type: 'poweredge-r750',
    netplan,
    serial_port_recommended: null,
    last_job_id: null,
    buildarch: 'amd64',
  });
}

const stubAtomFetcher: AtomFetcher = { getAtom: async () => null };
const stubRedis = { get: async () => null, delete: async () => 0 };

@Global()
@Module({
  providers: [
    { provide: ATOM_FETCHER, useValue: stubAtomFetcher },
    { provide: RedisService, useValue: stubRedis },
  ],
  exports: [ATOM_FETCHER, RedisService],
})
class TestInfraModule {}

async function buildBuilder(liveNetplan: string) {
  const getLiveNetplan = vi.fn(async () => liveNetplan);

  const moduleRef = await Test.createTestingModule({
    imports: [
      TestInfraModule,
      BridgeNetworkModule.forRoot(),
      IpxeModule.forRoot({ enqueueRenderRequest: async () => true }),
    ],
  })
    .overrideProvider(RedisService)
    .useValue(stubRedis)
    .overrideProvider(NetplanAtomService)
    .useValue({ getLiveNetplan })
    .overrideProvider(BridgeIpResolutionService)
    .useValue({ getBridgeIpForDevice: async () => '' })
    .compile();

  const builder = moduleRef.get<KernelNetworkBuilder>(IPXE_KERNEL_NETWORK_BUILDER);
  return { builder, getLiveNetplan, close: () => moduleRef.close() };
}

describe('iPXE kernel network params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the live netplan atom when the record carries no manual override', async () => {
    const { builder, getLiveNetplan, close } = await buildBuilder(VLAN_BOND_NETPLAN);

    const params = await builder(record(null), 'job-1');

    expect(getLiveNetplan).toHaveBeenCalledWith(DEVICE_UUID, { jobId: 'job-1', timeoutS: expect.any(Number) });
    expect(params).toContain('bond=bond0:eno1,eno2:mode=802.3ad');
    expect(params).toContain('vlan=bond0.105:bond0');
    expect(
      params.some((param) => param.startsWith('ip=10.20.30.40::10.20.30.1:255.255.255.0:') && param.includes(':bond0.105:')),
    ).toBe(true);
    expect(params).toContain('ifname=eno1:aa:bb:cc:dd:ee:01');
    expect(params).toContain('ifname=eno2:aa:bb:cc:dd:ee:02');

    await close();
  });

  it('uses the manual override without consulting the live atom', async () => {
    const manualNetplan = VLAN_BOND_NETPLAN.replace('bond0.105', 'bond0.777').replace('id: 105', 'id: 777');
    const { builder, getLiveNetplan, close } = await buildBuilder(VLAN_BOND_NETPLAN);

    const params = await builder(record(manualNetplan), 'job-2');

    expect(getLiveNetplan).not.toHaveBeenCalled();
    expect(params).toContain('vlan=bond0.777:bond0');

    await close();
  });

  it('returns no parameters when the manual and live netplans are empty', async () => {
    const { builder, close } = await buildBuilder('');

    const params = await builder(record(null), 'job-3');

    expect(params).toEqual([]);

    await close();
  });
});
