import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DnsPrefixOverrideAtomValue } from '../../dns/dns-atom-value.schema.js';
import { DnsConfigReaderService } from '../../dns/dns-config-reader.service.js';
import { dnsServeInterfaceIps } from '../../dns/dns-serve-interfaces.js';
import { DnsServerService } from '../../dns/dns-server.service.js';
import { resetAtomServedIpsForTests, setAtomServedIps } from '../atom-served-ips-holder.js';
import { buildDnsServerDeps } from '../dns-server-factory.js';

vi.mock('../../dns/dns-server.service.js', () => ({ DnsServerService: vi.fn() }));
vi.mock('../../dns/dns-serve-interfaces.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../dns/dns-serve-interfaces.js')>();
  return { ...actual, dnsServeInterfaceIps: vi.fn(() => []) };
});
vi.mock('../../common/redis/redis-client/ioredis-driver.js', () => ({
  createIoredisDriverFactory: vi.fn(() => vi.fn()),
}));
vi.mock('../../common/redis/redis-client/redis.client.js', () => {
  const RedisClient = vi.fn(function (this: { close: () => void }) {
    this.close = vi.fn();
  });
  return { RedisClient };
});
vi.mock('../../common/redis/redis-client/redis.config.js', () => ({
  loadRedisConfig: vi.fn().mockReturnValue({ host: 'localhost', port: 6379, prefix: '' }),
}));
vi.mock('../../dns/dns-config-reader.service.js', () => ({ DnsConfigReaderService: vi.fn() }));
vi.mock('../../logger/logger.service.js', () => ({
  ContextLogger: vi.fn(),
  logInfo: vi.fn().mockResolvedValue(undefined),
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  }),
}));

function ctorArgs() {
  return vi.mocked(DnsServerService).mock.calls[0][0];
}

describe('buildDnsServerDeps — atom-served bind set', () => {
  afterEach(() => {
    resetAtomServedIpsForTests();
    vi.mocked(DnsServerService).mockClear();
    vi.mocked(DnsConfigReaderService).mockClear();
    vi.mocked(dnsServeInterfaceIps).mockClear();
    vi.mocked(dnsServeInterfaceIps).mockReturnValue([]);
  });

  it('constructs the DNS service with a holder-backed listInterfaces (not host NICs)', () => {
    buildDnsServerDeps({}).createService();
    expect(DnsServerService).toHaveBeenCalledTimes(1);
    const { listInterfaces } = ctorArgs();
    expect(listInterfaces?.()).toEqual([]);
    setAtomServedIps([{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }]);
    expect(listInterfaces?.()).toEqual([{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }]);
  });

  it('constructs the DNS service with the holder-backed served-cidr thunk including relayed cidrs', () => {
    buildDnsServerDeps({}).createService();
    const { listServedCidrs } = ctorArgs();
    setAtomServedIps([{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }], ['172.16.80.0/24']);
    expect(listServedCidrs?.()).toEqual(['10.0.0.0/24', '172.16.80.0/24']);
  });

  it('unions dns-serve prefix NIC IPs and cidrs into the bind and served sets', () => {
    buildDnsServerDeps({}).createService();
    const { listInterfaces, listServedCidrs, onPrefixOverrides } = ctorArgs();
    setAtomServedIps([{ interface: 'br-brokkr', ip: '192.168.200.1', cidr: '192.168.200.0/24' }]);
    vi.mocked(dnsServeInterfaceIps).mockReturnValue([
      { interface: 'enp1s0f1np1', ip: '172.16.8.101', cidr: '172.16.8.0/22' },
    ]);

    const overrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['prefix-1', { serveDns: true, upstreamOverride: null, cidr: '172.16.8.0/22' }],
    ]);
    onPrefixOverrides?.(overrides);

    expect(vi.mocked(dnsServeInterfaceIps)).toHaveBeenCalledWith(overrides);
    expect(listInterfaces?.()).toEqual([
      { interface: 'br-brokkr', ip: '192.168.200.1', cidr: '192.168.200.0/24' },
      { interface: 'enp1s0f1np1', ip: '172.16.8.101', cidr: '172.16.8.0/22' },
    ]);
    expect(listServedCidrs?.()).toEqual(['192.168.200.0/24', '172.16.8.0/22']);
  });

  it('drops the dns-serve contribution when overrides are cleared', () => {
    buildDnsServerDeps({}).createService();
    const { listInterfaces, listServedCidrs, onPrefixOverrides } = ctorArgs();
    vi.mocked(dnsServeInterfaceIps).mockReturnValue([
      { interface: 'enp1s0f1np1', ip: '172.16.8.101', cidr: '172.16.8.0/22' },
    ]);
    onPrefixOverrides?.(
      new Map<string, DnsPrefixOverrideAtomValue>([
        ['prefix-1', { serveDns: true, upstreamOverride: null, cidr: '172.16.8.0/22' }],
      ]),
    );
    expect(listInterfaces?.()).toHaveLength(1);

    vi.mocked(dnsServeInterfaceIps).mockReturnValue([]);
    onPrefixOverrides?.(new Map());
    expect(listInterfaces?.()).toEqual([]);
    expect(listServedCidrs?.()).toEqual([]);
  });

  it('the wired bind source is empty before a hot-swap and reflects what the DHCP manager publishes', () => {
    buildDnsServerDeps({}).createService();
    const { listInterfaces } = ctorArgs();
    expect(listInterfaces()).toEqual([]);
    const published = [
      { interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' },
      { interface: 'br-brokkr', ip: '192.168.200.1', cidr: '192.168.200.0/24' },
    ];
    setAtomServedIps(published);
    expect(listInterfaces()).toEqual(published);
  });

  it('builds a disabled baseline config regardless of env', () => {
    const deps = buildDnsServerDeps({ DNS_ENABLED: 'true', DHCP_SERVER_ID: '10.0.0.250' });
    deps.createService();
    const { listInterfaces } = ctorArgs();
    setAtomServedIps([{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }]);
    expect(listInterfaces()).toEqual([{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }]);
    expect(deps.config.enabled).toBe(false);
  });

  it('wires configReader, readRecords and onStop when BROKKR_ZONE_ID is set', () => {
    buildDnsServerDeps({ BROKKR_ZONE_ID: 'zone-abc' }).createService();
    const args = ctorArgs();
    expect(args.configReader).toBeDefined();
    expect(DnsConfigReaderService).toHaveBeenCalledTimes(1);
    expect(typeof args.readRecords).toBe('function');
    expect(typeof args.onStop).toBe('function');
  });

  it('omits configReader, readRecords and onStop when BROKKR_ZONE_ID is absent', () => {
    buildDnsServerDeps({}).createService();
    const args = ctorArgs();
    expect(args.configReader).toBeUndefined();
    expect(DnsConfigReaderService).not.toHaveBeenCalled();
    expect(args.readRecords).toBeUndefined();
    expect(args.onStop).toBeUndefined();
  });

  it('omits configReader, readRecords and onStop when BROKKR_ZONE_ID is empty', () => {
    buildDnsServerDeps({ BROKKR_ZONE_ID: '  ' }).createService();
    const args = ctorArgs();
    expect(args.configReader).toBeUndefined();
    expect(args.readRecords).toBeUndefined();
    expect(args.onStop).toBeUndefined();
  });
});
