import { afterEach, describe, expect, it, vi } from 'vitest';

import { DnsConfigReaderService } from '../../dns/dns-config-reader.service.js';
import { DnsServerService } from '../../dns/dns-server.service.js';
import { getAtomServedCidrs, getAtomServedIps, resetAtomServedIpsForTests, setAtomServedIps } from '../atom-served-ips-holder.js';
import { buildDnsServerDeps } from '../dns-server-factory.js';

vi.mock('../../dns/dns-server.service.js', () => ({ DnsServerService: vi.fn() }));
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
  });

  it('constructs the DNS service with getAtomServedIps as its listInterfaces (not host NICs)', () => {
    buildDnsServerDeps({}).createService();
    expect(DnsServerService).toHaveBeenCalledTimes(1);
    expect(ctorArgs().listInterfaces).toBe(getAtomServedIps);
  });

  it('constructs the DNS service with the holder-backed served-cidr thunk including relayed cidrs', () => {
    buildDnsServerDeps({}).createService();
    expect(ctorArgs().listServedCidrs).toBe(getAtomServedCidrs);
    setAtomServedIps([{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }], ['172.16.80.0/24']);
    expect(getAtomServedCidrs()).toEqual(['10.0.0.0/24', '172.16.80.0/24']);
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
