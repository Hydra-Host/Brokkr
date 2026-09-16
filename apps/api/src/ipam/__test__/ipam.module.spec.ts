import { Test } from '@nestjs/testing';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { DhcpConfigRedisWriterService } from 'src/brokkr-bridge/dhcp/dhcp-config-redis-writer.service';
import { DhcpDerivationService } from 'src/brokkr-bridge/dhcp/dhcp-derivation.service';
import { DhcpLeaseReaderService } from 'src/brokkr-bridge/dhcp/dhcp-lease-reader.service';
import { DnsConfigPublisherService } from 'src/brokkr-bridge/dns/dns-config-publisher.service';
import { NetplanLiveInvalidatorService } from 'src/brokkr-bridge/netplan/netplan-live-invalidator.service';
import { VrrpRedisWriterService } from 'src/brokkr-bridge/vrrp/vrrp-redis-writer.service';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { describe, expect, it, vi } from 'vitest';
import { IpamChangelogRepository } from '../changelog/changelog.repository';
import { IpamChangelogService } from '../changelog/changelog.service';
import { IpAddressRepository } from '../ip-address/ip-address.repository';
import { IpAddressService } from '../ip-address/ip-address.service';
import { IpRangeRepository } from '../ip-range/ip-range.repository';
import { IpRangeService } from '../ip-range/ip-range.service';
import { PrefixRepository } from '../prefix/prefix.repository';
import { PrefixService } from '../prefix/prefix.service';
import { VlanRepository } from '../vlan/vlan.repository';
import { VlanService } from '../vlan/vlan.service';
import { VrfRepository } from '../vrf/vrf.repository';
import { VrfService } from '../vrf/vrf.service';

describe('IPAM module service delegation coverage', () => {
  class TestContextService extends ContextService {
    override requirePermission(): undefined {
      return undefined;
    }
    override get organizationId(): string {
      return '11111111-1111-1111-1111-111111111111';
    }
  }

  async function assertDelegation(
    serviceToken: new (...args: any[]) => any,
    repositoryToken: new (...args: any[]) => any,
    methodName: string,
    args: unknown[],
    extraRepoArgs: unknown[] = [],
  ) {
    const expectedResult = { methodName, args };
    const repositoryMock = {
      [methodName]: vi.fn().mockResolvedValue(expectedResult),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        serviceToken,
        {
          provide: repositoryToken,
          useValue: repositoryMock,
        },
        {
          provide: ContextService,
          useValue: new TestContextService(new DesignationOperatorPolicy()),
        },
        {
          provide: VrrpRedisWriterService,
          useValue: { set: vi.fn(), clear: vi.fn() },
        },
        {
          provide: DhcpConfigRedisWriterService,
          useValue: { set: vi.fn(), clear: vi.fn() },
        },
        {
          provide: DhcpDerivationService,
          useValue: {
            deriveAll: vi.fn(),
            deriveOne: vi.fn(),
            listReservationsForPrefix: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: DhcpConfigPublisherService,
          useValue: {
            republishPrefixes: vi.fn(),
            republishForDevice: vi.fn(),
            republishForIpAddress: vi.fn(),
            republishForReservation: vi.fn(),
          },
        },
        {
          provide: DhcpLeaseReaderService,
          useValue: { listLeasesForPrefix: vi.fn().mockResolvedValue([]) },
        },
        {
          provide: DnsConfigPublisherService,
          useValue: { publishPrefixDnsOverride: vi.fn(), clearZoneDnsConfig: vi.fn() },
        },
        {
          provide: `LoggerService${PrefixService.name}`,
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        { provide: NetplanLiveInvalidatorService, useValue: { forInterface: vi.fn() } },
      ],
    }).compile();

    const service = moduleRef.get(serviceToken);
    if (typeof service !== 'object' || service === null) {
      throw new Error('Service instance was not created');
    }

    const serviceMethod = Reflect.get(service, methodName);
    if (typeof serviceMethod !== 'function') {
      throw new Error(`Service method ${methodName} was not found`);
    }

    const result = await serviceMethod.apply(service, args);

    expect(repositoryMock[methodName]).toHaveBeenCalledWith(...args, ...extraRepoArgs);
    expect(result).toEqual(expectedResult);
  }

  const vrfCases: Array<{ methodName: string; args: unknown[] }> = [
    { methodName: 'listVrfs', args: [{ includeArchived: false }] },
  ];

  const prefixCases: Array<{ methodName: string; args: unknown[] }> = [
    { methodName: 'listPrefixes', args: [{ includeArchived: false }] },
    { methodName: 'listChildPrefixes', args: ['prefix-1'] },
    { methodName: 'listIpsInPrefix', args: ['prefix-1'] },
    { methodName: 'getPrefixUtilization', args: ['prefix-1'] },
    { methodName: 'allocateNextPrefix', args: ['prefix-1', { targetMask: 28 }] },
    { methodName: 'detectPrefixOverlap', args: [{ prefix: '10.0.0.0/25' }] },
    { methodName: 'validatePrefixGatewayRequest', args: [{ prefixId: 'prefix-1', gatewayIpId: 'ip-1' }] },
  ];

  const vlanCases: Array<{ methodName: string; args: unknown[] }> = [
    { methodName: 'listVlans', args: [{ includeArchived: false }] },
  ];

  const ipAddressCases: Array<{ methodName: string; args: unknown[] }> = [
    { methodName: 'listIpAddresses', args: [{ includeArchived: false }] },
  ];

  const ipRangeCases: Array<{ methodName: string; args: unknown[] }> = [
    { methodName: 'listIpRanges', args: [{ includeArchived: false }] },
    { methodName: 'detectIpRangeOverlap', args: [{ prefixId: 'prefix-1', start: '10.0.0.12', end: '10.0.0.18' }] },
  ];

  const changelogCases: Array<{ methodName: string; args: unknown[] }> = [
    { methodName: 'listIpamChangelog', args: [{ limit: 10 }] },
  ];

  for (const testCase of vrfCases) {
    it(`VrfService delegates ${testCase.methodName}`, async () => {
      await assertDelegation(VrfService, VrfRepository, testCase.methodName, testCase.args);
    });
  }

  for (const testCase of prefixCases) {
    it(`PrefixService delegates ${testCase.methodName}`, async () => {
      await assertDelegation(PrefixService, PrefixRepository, testCase.methodName, testCase.args);
    });
  }

  for (const testCase of vlanCases) {
    it(`VlanService delegates ${testCase.methodName}`, async () => {
      await assertDelegation(VlanService, VlanRepository, testCase.methodName, testCase.args);
    });
  }

  for (const testCase of ipAddressCases) {
    it(`IpAddressService delegates ${testCase.methodName}`, async () => {
      await assertDelegation(IpAddressService, IpAddressRepository, testCase.methodName, testCase.args);
    });
  }

  for (const testCase of ipRangeCases) {
    it(`IpRangeService delegates ${testCase.methodName}`, async () => {
      await assertDelegation(IpRangeService, IpRangeRepository, testCase.methodName, testCase.args);
    });
  }

  for (const testCase of changelogCases) {
    it(`IpamChangelogService delegates ${testCase.methodName}`, async () => {
      await assertDelegation(IpamChangelogService, IpamChangelogRepository, testCase.methodName, testCase.args, [
        '11111111-1111-1111-1111-111111111111',
      ]);
    });
  }
});
