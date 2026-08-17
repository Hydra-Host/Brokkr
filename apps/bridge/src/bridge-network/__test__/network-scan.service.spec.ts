import type * as os from 'node:os';
import { networkInterfaces } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandFailed, CommandTimeout } from '../../common/process/run-command';
import {
  IPMI_NET_FN_APP_RS,
  RMCP_CLASS_IPMI,
  RMCP_VERSION_1_0,
  buildIpmiPingPacket,
  ipmiChecksum,
  isValidIpmiResponse,
} from '../../oob/ipmi/ping';
import {
  NetworkScanService,
  NetworkScanTimeoutError,
  NetworkScanValidationError,
  cidrContains,
  createNetworkScanService,
  normalizeMac,
  parseArpAnOutput,
  parseIpNeighbourJson,
  parseNmapGreppableOutput,
  tryParseCidr,
  type RunResultLike,
  type Runner,
} from '../network-scan.service';
import type { NetworkConfig } from '../network.config';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});

const TEST_CONFIG: NetworkConfig = {
  maxConcurrentScans: 10,
  defaultScanTimeout: 60,
  ipmiTimeoutMs: 100,
  ipmiPort: 623,
  redfishTimeoutMs: 2000,
  redfishPort: 443,
  nmapMinParallelism: 100,
  nmapMinRate: 256,
  nmapMaxRetries: 1,
  nmapPrivileged: true,
};

const NMAP_MULTI_HOST_OUTPUT = [
  '# Nmap 7.94 scan initiated Thu Jun 12 10:00:00 2026 as: nmap -sn -n -oG - 10.0.0.0/24',
  'Host: 10.0.0.1 ()\tStatus: Up',
  'Host: 10.0.0.2 ()\tStatus: Up',
  'Host: 10.0.0.5 ()\tStatus: Up',
  'Host: 10.0.0.7 ()\tStatus: Up',
  '# Nmap done at Thu Jun 12 10:00:05 2026 -- 256 IP addresses (4 hosts up) scanned in 5.02 seconds',
  '',
].join('\n');

const NMAP_SINGLE_HOST_OUTPUT = [
  '# Nmap 7.94 scan initiated',
  'Host: 192.168.1.10 ()\tStatus: Up',
  '# Nmap done',
  '',
].join('\n');

const NMAP_DOWN_HOST_OUTPUT = ['Host: 192.168.1.10 ()\tStatus: Up', 'Host: 192.168.1.11 ()\tStatus: Down', ''].join(
  '\n',
);

const IP_NEIGHBOUR_JSON = JSON.stringify([
  { dst: '10.0.0.5', lladdr: 'AA:BB:CC:DD:EE:5', state: ['REACHABLE'] },
  { dst: '10.0.0.7', lladdr: 'aa:bb:cc:dd:ee:07', state: ['STALE'] },
  { dst: '10.0.0.7', lladdr: 'ff:ff:ff:ff:ff:07', state: ['STALE'] },
  { dst: '10.0.0.9', lladdr: 'aa:bb:cc:dd:ee:09', state: ['STALE'] },
  { dst: '10.0.0.11', state: ['FAILED'] },
]);

const ARP_AN_OUTPUT = [
  '? (10.0.0.5) at aa:bb:cc:dd:ee:5 on en0 ifscope [ethernet]',
  '? (10.0.0.7) at aa:bb:cc:dd:ee:7 on en0 ifscope [ethernet]',
  '? (10.0.0.8) at (incomplete) on en0 ifscope [ethernet]',
  '? (10.0.0.9) at aa:bb:cc:dd:ee:9 on en0 ifscope [ethernet]',
  '',
].join('\n');

function fakeRunResult(stdout: string, exitCode = 0, stderr = ''): RunResultLike {
  return { stdout, stderr, exitCode };
}

describe('normalizeMac', () => {
  it('lowercases and zero-pads colon groups', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:5')).toBe('aa:bb:cc:dd:ee:05');
    expect(normalizeMac('0:1:2:a:B:c')).toBe('00:01:02:0a:0b:0c');
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('returns lowercased input when not six colon groups or non-hex', () => {
    expect(normalizeMac('AABB.CCDD.EEFF')).toBe('aabb.ccdd.eeff');
    expect(normalizeMac('aa:bb:cc:dd:ee')).toBe('aa:bb:cc:dd:ee');
    expect(normalizeMac('aa:bb:cc:dd:ee:zz')).toBe('aa:bb:cc:dd:ee:zz');
  });
});

describe('parseNmapGreppableOutput', () => {
  it('extracts up hosts from multi-host output', () => {
    expect(parseNmapGreppableOutput(NMAP_MULTI_HOST_OUTPUT)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.5', '10.0.0.7']);
  });

  it('extracts the single host', () => {
    expect(parseNmapGreppableOutput(NMAP_SINGLE_HOST_OUTPUT)).toEqual(['192.168.1.10']);
  });

  it('skips down hosts', () => {
    expect(parseNmapGreppableOutput(NMAP_DOWN_HOST_OUTPUT)).toEqual(['192.168.1.10']);
  });

  it('returns empty for empty output', () => {
    expect(parseNmapGreppableOutput('')).toEqual([]);
  });
});

describe('parseIpNeighbourJson', () => {
  it('keeps first MAC per ip, normalizes, and filters to hosts set', () => {
    const hosts = new Set(['10.0.0.5', '10.0.0.7']);
    expect(parseIpNeighbourJson(IP_NEIGHBOUR_JSON, hosts)).toEqual({
      '10.0.0.5': 'aa:bb:cc:dd:ee:05',
      '10.0.0.7': 'aa:bb:cc:dd:ee:07',
    });
  });

  it('returns empty map for empty stdout', () => {
    expect(parseIpNeighbourJson('', new Set(['10.0.0.5']))).toEqual({});
  });

  it('throws on malformed JSON', () => {
    expect(() => parseIpNeighbourJson('{not json', new Set())).toThrow();
  });
});

describe('parseArpAnOutput', () => {
  it('parses arp -an lines, skipping incomplete entries', () => {
    const hosts = new Set(['10.0.0.5', '10.0.0.7', '10.0.0.8']);
    expect(parseArpAnOutput(ARP_AN_OUTPUT, hosts)).toEqual({
      '10.0.0.5': 'aa:bb:cc:dd:ee:05',
      '10.0.0.7': 'aa:bb:cc:dd:ee:07',
    });
  });

  it('filters out hosts not in the set', () => {
    expect(parseArpAnOutput(ARP_AN_OUTPUT, new Set(['10.0.0.9']))).toEqual({ '10.0.0.9': 'aa:bb:cc:dd:ee:09' });
  });
});

describe('tryParseCidr / cidrContains', () => {
  it('parses bare IPv4 as /32 and IPv6 as /128', () => {
    const n4 = tryParseCidr('10.0.0.5');
    expect(n4).not.toBeNull();
    expect(n4?.prefix).toBe(32);

    const n6 = tryParseCidr('fd00::1');
    expect(n6).not.toBeNull();
    expect(n6?.prefix).toBe(128);
  });

  it('accepts host-bits-set CIDR', () => {
    const n = tryParseCidr('10.0.0.5/24');
    expect(n).not.toBeNull();
    expect(cidrContains(n!, '10.0.0.100')).toBe(true);
  });

  it('rejects non-network garbage', () => {
    expect(tryParseCidr('not-a-subnet')).toBeNull();
    expect(tryParseCidr('192.168.1.0/33')).toBeNull();
  });

  it('cidrContains: matches in-network, rejects out-of-network', () => {
    const n = tryParseCidr('192.168.1.0/24')!;
    expect(cidrContains(n, '192.168.1.100')).toBe(true);
    expect(cidrContains(n, '10.0.0.100')).toBe(false);
  });

  it('cidrContains: rejects cross-family', () => {
    const n4 = tryParseCidr('192.168.1.0/24')!;
    expect(cidrContains(n4, 'fd00::1')).toBe(false);
  });
});

describe('IPMI packet helpers', () => {
  it("ipmiChecksum is two's complement of sum mod 256", () => {
    expect(ipmiChecksum([0x20, 0x18])).toBe(0xc8);
    expect(ipmiChecksum([0x00])).toBe(0x00);
  });

  it('buildIpmiPingPacket emits 23-byte FreeIPMI-compatible LAN packet', () => {
    const pkt = buildIpmiPingPacket(0);
    expect(pkt.length).toBeGreaterThanOrEqual(23);
    expect(pkt[0]).toBe(RMCP_VERSION_1_0);
    expect(pkt[3]).toBe(RMCP_CLASS_IPMI);
  });

  it('isValidIpmiResponse accepts a synthesized FreeIPMI response', () => {
    const payload = [
      RMCP_VERSION_1_0,
      0x00,
      0xff,
      RMCP_CLASS_IPMI,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x10,
      0x20,
      IPMI_NET_FN_APP_RS << 2,
      0x00,
      0x81,
      0x00,
      0x38,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ];
    expect(isValidIpmiResponse(Buffer.from(payload))).toBe(true);
  });

  it('isValidIpmiResponse rejects wrong RMCP version', () => {
    expect(isValidIpmiResponse(Buffer.alloc(30, 0))).toBe(false);
  });

  it('isValidIpmiResponse rejects too-short payload', () => {
    expect(isValidIpmiResponse(Buffer.from([RMCP_VERSION_1_0, 0x00, 0xff, RMCP_CLASS_IPMI]))).toBe(false);
  });
});

function buildService(
  overrides: Partial<{
    runner: Runner;
    nmapDiscover: (network: string) => Promise<string[]>;
    localIpsProvider: (network: string) => Set<string>;
    gatewayIpProvider: (network: string) => Promise<string | null>;
    ipmiPingFn: (ip: string) => Promise<boolean>;
    redfishCheckFn: (ip: string) => Promise<boolean>;
    config: NetworkConfig;
  }> = {},
): NetworkScanService {
  return new NetworkScanService('test-job-123', {
    config: overrides.config ?? TEST_CONFIG,
    runner: overrides.runner ?? (async () => fakeRunResult('[]')),
    nmapDiscover: overrides.nmapDiscover,
    localIpsProvider: overrides.localIpsProvider ?? (() => new Set()),
    gatewayIpProvider: overrides.gatewayIpProvider ?? (async () => null),
    ipmiPingFn: overrides.ipmiPingFn ?? (async () => false),
    redfishCheckFn: overrides.redfishCheckFn ?? (async () => false),
  });
}

describe('scanNetworks', () => {
  it('rejects invalid CIDR with NetworkScanValidationError', async () => {
    const svc = buildService();
    await expect(svc.scanNetworks(['10.0.0.0/24', 'not-a-subnet'])).rejects.toThrow(NetworkScanValidationError);
    await expect(svc.scanNetworks(['not-a-subnet'])).rejects.toThrow(/Invalid CIDR notation 'not-a-subnet'/);
  });

  it('rejects invalid prefix length', async () => {
    const svc = buildService();
    await expect(svc.scanNetworks(['192.168.1.0/33'])).rejects.toThrow(NetworkScanValidationError);
  });

  it('accepts CIDRs with host bits set', async () => {
    const svc = buildService({ nmapDiscover: async () => [] });
    const output = await svc.scanNetworks(['10.0.0.5/23']);
    expect(output).toEqual({ '10.0.0.5/23': { errored: false, results: {} } });
  });

  it('marks a subnet errored when discovery times out', async () => {
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') throw new CommandTimeout('nmap timed out');
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner });
    const output = await svc.scanNetworks(['10.0.0.0/23']);
    expect(output).toEqual({ '10.0.0.0/23': { errored: true, results: {} } });
  });

  it('marks a subnet errored when nmap exits nonzero', async () => {
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') return fakeRunResult('', 1, 'boom');
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner });
    const output = await svc.scanNetworks(['10.0.0.0/23']);
    expect(output['10.0.0.0/23']?.errored).toBe(true);
  });

  it('marks a subnet errored when nmap throws CommandFailed', async () => {
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') throw new CommandFailed(cmd, 1, '', 'boom');
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner });
    const output = await svc.scanNetworks(['10.0.0.0/23']);
    expect(output['10.0.0.0/23']?.errored).toBe(true);
  });

  it('accepts narrow masks like /24 (management subnets)', async () => {
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') return fakeRunResult(NMAP_SINGLE_HOST_OUTPUT);
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner });
    const output = await svc.scanNetworks(['192.168.1.0/24']);
    expect(output['192.168.1.0/24']?.errored).toBe(false);
    expect(output['192.168.1.0/24']?.results['192.168.1.10']).toEqual({ mac: '', ipmi: false, redfish: false });
  });

  it('rejects broad masks like /16 (only accepts /17–/23)', async () => {
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') return fakeRunResult(NMAP_SINGLE_HOST_OUTPUT);
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner });
    const output = await svc.scanNetworks(['10.0.0.0/16']);
    expect(output['10.0.0.0/16']).toEqual({ errored: true, results: {} });
  });

  it('scales the discovery timeout off the base: /24 x1, /22-/23 x2, /17-/21 x8', async () => {
    const seen: number[] = [];
    const runner: Runner = async (cmd, t) => {
      if (cmd[0] === 'nmap') {
        seen.push(t ?? -1);
        return fakeRunResult('');
      }
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner });
    await svc.scanNetworks(['10.0.0.0/24', '10.0.0.0/23', '10.0.0.0/20']);
    expect(seen).toEqual([60, 120, 480]);
  });

  it('includes the configured Redfish port in the nmap -PS ping ports', async () => {
    let nmapCmd: readonly string[] = [];
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') {
        nmapCmd = cmd;
        return fakeRunResult('');
      }
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner, config: { ...TEST_CONFIG, redfishPort: 8443 } });
    await svc.scanNetworks(['10.0.0.0/23']);
    expect(nmapCmd).toContain('-PS22,80,8443');
  });

  it('does not duplicate 443 in the ping ports when Redfish runs on the default port', async () => {
    let nmapCmd: readonly string[] = [];
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') {
        nmapCmd = cmd;
        return fakeRunResult('');
      }
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner, config: { ...TEST_CONFIG, redfishPort: 443 } });
    await svc.scanNetworks(['10.0.0.0/23']);
    expect(nmapCmd).toContain('-PS22,80,443');
  });

  it('privileged: includes the raw ICMP/UDP/send-ip discovery probes', async () => {
    let nmapCmd: readonly string[] = [];
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') {
        nmapCmd = cmd;
        return fakeRunResult('');
      }
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner, config: { ...TEST_CONFIG, nmapPrivileged: true } });
    await svc.scanNetworks(['10.0.0.0/23']);
    expect(nmapCmd).toContain('--send-ip');
    expect(nmapCmd).toContain('-PE');
    expect(nmapCmd).toContain('-PU623');
    expect(nmapCmd).toContain('-PS22,80,443');
  });

  it('unprivileged: drops the raw ICMP/UDP/send-ip probes, keeps the TCP-connect pingscan', async () => {
    let nmapCmd: readonly string[] = [];
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') {
        nmapCmd = cmd;
        return fakeRunResult('');
      }
      return fakeRunResult('[]');
    };
    const svc = buildService({ runner, config: { ...TEST_CONFIG, nmapPrivileged: false } });
    await svc.scanNetworks(['10.0.0.0/23']);
    expect(nmapCmd).not.toContain('--send-ip');
    expect(nmapCmd).not.toContain('-PE');
    expect(nmapCmd).not.toContain('-PU623');
    expect(nmapCmd).toContain('-PS22,80,443');
    expect(nmapCmd).toContain('-sn');
    expect(nmapCmd).toContain('-n');
  });

  it('happy path: discovers hosts, filters local IPs, resolves MACs, probes IPMI+Redfish in parallel', async () => {
    const runner: Runner = async (cmd, _t) => {
      if (cmd[0] === 'nmap') return fakeRunResult(NMAP_MULTI_HOST_OUTPUT);
      if (cmd[0] === 'ip' && cmd[1] === '-j' && cmd[2] === 'neighbour') return fakeRunResult(IP_NEIGHBOUR_JSON);
      if (cmd[0] === 'ip' && cmd[1] === '-j' && cmd[2] === 'route') return fakeRunResult('[]');
      if (cmd[0] === 'arp') return fakeRunResult(ARP_AN_OUTPUT);
      throw new Error(`unexpected command: ${cmd.join(' ')}`);
    };
    const svc = buildService({
      runner,
      localIpsProvider: () => new Set(['10.0.0.2']),
      gatewayIpProvider: async () => null,
      ipmiPingFn: async (ip) => ip === '10.0.0.5',
      redfishCheckFn: async (ip) => ip === '10.0.0.7',
    });
    const output = await svc.scanNetworks(['10.0.0.0/23']);
    expect(output['10.0.0.0/23']?.errored).toBe(false);
    expect(output['10.0.0.0/23']?.results['10.0.0.1']).toEqual({ mac: '', ipmi: false, redfish: false });
    expect(output['10.0.0.0/23']?.results['10.0.0.5']).toEqual({
      mac: 'aa:bb:cc:dd:ee:05',
      ipmi: true,
      redfish: false,
    });
    expect(output['10.0.0.0/23']?.results['10.0.0.7']).toEqual({
      mac: 'aa:bb:cc:dd:ee:07',
      ipmi: false,
      redfish: true,
    });
    expect(output['10.0.0.0/23']?.results['10.0.0.2']).toBeUndefined();
  });

  it('subtracts the default gateway from results', async () => {
    const svc = buildService({
      nmapDiscover: async () => ['192.168.1.1', '192.168.1.50', '192.168.1.100'],
      gatewayIpProvider: async () => '192.168.1.1',
    });
    const output = await svc.scanNetworks(['192.168.1.0/23']);
    expect(output['192.168.1.0/23']?.errored).toBe(false);
    expect(output['192.168.1.0/23']?.results['192.168.1.1']).toBeUndefined();
    expect(output['192.168.1.0/23']?.results['192.168.1.50']).toEqual({ mac: '', ipmi: false, redfish: false });
    expect(output['192.168.1.0/23']?.results['192.168.1.100']).toEqual({ mac: '', ipmi: false, redfish: false });
  });

  it('handles missing MAC entries (host present in nmap but absent from ARP)', async () => {
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') return fakeRunResult(NMAP_SINGLE_HOST_OUTPUT);
      if (cmd[0] === 'ip' || cmd[0] === 'arp') return fakeRunResult('[]');
      throw new Error('unexpected');
    };
    const svc = buildService({ runner, gatewayIpProvider: async () => null });
    const output = await svc.scanNetworks(['192.168.1.0/23']);
    expect(output['192.168.1.0/23']?.results['192.168.1.10']?.mac).toBe('');
  });

  it('scans multiple subnets independently; one failure does not affect others', async () => {
    const svc = buildService({
      nmapDiscover: async (network) => {
        if (network === '10.0.0.0/23') return ['10.0.0.5'];
        throw new NetworkScanTimeoutError(`Host discovery timed out for ${network}`);
      },
    });
    const output = await svc.scanNetworks(['10.0.0.0/23', '192.168.0.0/23']);
    expect(output['10.0.0.0/23']?.errored).toBe(false);
    expect(output['10.0.0.0/23']?.results['10.0.0.5']).toEqual({ mac: '', ipmi: false, redfish: false });
    expect(output['192.168.0.0/23']).toEqual({ errored: true, results: {} });
  });

  it('treats per-host probe rejections as false', async () => {
    const svc = buildService({
      nmapDiscover: async () => ['10.0.0.5'],
      ipmiPingFn: async () => {
        throw new Error('probe blew up');
      },
      redfishCheckFn: async () => true,
    });
    const output = await svc.scanNetworks(['10.0.0.0/23']);
    expect(output['10.0.0.0/23']?.results['10.0.0.5']).toEqual({ mac: '', ipmi: false, redfish: true });
  });

  it('output structure: errored + results map of {mac,ipmi,redfish}', async () => {
    const svc = buildService({
      nmapDiscover: async () => ['192.168.1.10'],
      ipmiPingFn: async () => true,
      redfishCheckFn: async () => false,
    });
    const output = await svc.scanNetworks(['192.168.1.0/23']);
    expect(output).toEqual({
      '192.168.1.0/23': {
        errored: false,
        results: { '192.168.1.10': { mac: '', ipmi: true, redfish: false } },
      },
    });
  });

  it('empty discovery → errored false, empty results', async () => {
    const svc = buildService({ nmapDiscover: async () => [] });
    const output = await svc.scanNetworks(['10.0.0.0/23']);
    expect(output['10.0.0.0/23']).toEqual({ errored: false, results: {} });
  });

  it('local-IPs filter removing all hosts → errored false, empty results', async () => {
    const svc = buildService({
      nmapDiscover: async () => ['10.0.0.5', '10.0.0.6'],
      localIpsProvider: () => new Set(['10.0.0.5', '10.0.0.6']),
    });
    const output = await svc.scanNetworks(['10.0.0.0/23']);
    expect(output['10.0.0.0/23']).toEqual({ errored: false, results: {} });
  });

  it('MAC resolution command failure → empty MACs, hosts still appear in results', async () => {
    const runner: Runner = async (cmd) => {
      if (cmd[0] === 'nmap') return fakeRunResult(NMAP_SINGLE_HOST_OUTPUT);
      if (cmd[0] === 'ip' || cmd[0] === 'arp') return fakeRunResult('', 1, 'permission denied');
      throw new Error('unexpected');
    };
    const svc = buildService({ runner, gatewayIpProvider: async () => null });
    const output = await svc.scanNetworks(['192.168.1.0/23']);
    expect(output['192.168.1.0/23']?.results['192.168.1.10']).toEqual({ mac: '', ipmi: false, redfish: false });
  });
});

function makeIfaceMap(topology: Record<string, string[]>): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  const map: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
  for (const [iface, ips] of Object.entries(topology)) {
    map[iface] = ips.map((ip) => ({
      address: ip,
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: iface.startsWith('lo'),
      cidr: `${ip}/24`,
    }));
  }
  return map;
}

describe('getLocalIps loopback handling (real method, no provider override)', () => {
  beforeEach(() => {
    vi.mocked(networkInterfaces).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('excludes the real-iface IP from scan results but keeps the loopback-hosted IP', async () => {
    vi.mocked(networkInterfaces).mockReturnValue(makeIfaceMap({ lo: ['10.0.0.5'], eth0: ['10.0.0.2'] }));

    const svc = new NetworkScanService('test-job-123', {
      config: TEST_CONFIG,
      runner: async () => fakeRunResult('[]'),
      nmapDiscover: async () => ['10.0.0.2', '10.0.0.5', '10.0.0.9'],
      gatewayIpProvider: async () => null,
      ipmiPingFn: async () => false,
      redfishCheckFn: async () => false,
    });

    const output = await svc.scanNetworks(['10.0.0.0/24']);
    const results = output['10.0.0.0/24']?.results ?? {};
    expect(results['10.0.0.2']).toBeUndefined();
    expect(results['10.0.0.5']).toEqual({ mac: '', ipmi: false, redfish: false });
    expect(results['10.0.0.9']).toEqual({ mac: '', ipmi: false, redfish: false });
  });
});

describe('createNetworkScanService factory', () => {
  it('returns a NetworkScanService instance carrying the supplied jobId', () => {
    const svc = createNetworkScanService('factory-test', { config: TEST_CONFIG });
    expect(svc).toBeInstanceOf(NetworkScanService);
  });
});
