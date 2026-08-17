import { describe, expect, it } from 'vitest';

import {
  IcmpService,
  computeExtendedRttStats,
  createIcmpService,
  formatPingResponse,
  parsePingOutput,
  type PingMetrics,
} from '../icmp.service';

function svc(): IcmpService {
  return new IcmpService('test');
}

describe('IcmpService construction', () => {
  it('createIcmpService returns a service', () => {
    const s = createIcmpService('job-1');
    expect(s).toBeInstanceOf(IcmpService);
  });

  it('default jobId is empty', () => {
    const s = new IcmpService();
    expect(s).toBeDefined();
  });
});

describe('validateIpAddress', () => {
  it('valid IPv4', () => {
    expect(svc().validateIpAddress('192.168.1.1')).toBe('192.168.1.1');
  });

  it('valid IPv6', () => {
    expect(svc().validateIpAddress('2001:db8::1')).toBe('2001:db8::1');
  });

  it('valid hostname', () => {
    expect(svc().validateIpAddress('host.example.com')).toBe('host.example.com');
  });

  it('empty string throws', () => {
    expect(() => svc().validateIpAddress('')).toThrow();
  });

  it('whitespace is trimmed', () => {
    expect(svc().validateIpAddress('  10.0.0.1  ')).toBe('10.0.0.1');
  });

  it('dangerous chars throw', () => {
    expect(() => svc().validateIpAddress('1.1.1.1; rm -rf /')).toThrow();
    expect(() => svc().validateIpAddress('1.1.1.1`')).toThrow();
    expect(() => svc().validateIpAddress('1.1.1.1|cat')).toThrow();
  });

  it('invalid hostname format throws', () => {
    expect(() => svc().validateIpAddress('not_a_host!')).toThrow();
  });

  it('hostname too long throws', () => {
    expect(() => svc().validateIpAddress('a'.repeat(254))).toThrow();
  });

  it('hostname starting with hyphen throws', () => {
    expect(() => svc().validateIpAddress('-bad.example.com')).toThrow();
  });

  it('hostname ending with hyphen throws', () => {
    expect(() => svc().validateIpAddress('example.com-')).toThrow();
  });

  it('hostname with double dots throws', () => {
    expect(() => svc().validateIpAddress('host..example.com')).toThrow();
  });
});

describe('validatePingParameters', () => {
  it('valid parameters', () => {
    expect(svc().validatePingParameters(5, 3, 56, 1000)).toEqual([5, 3, 56, 1000]);
  });

  it('count out-of-range low', () => {
    expect(() => svc().validatePingParameters(0, 3, 56, 1000)).toThrow();
  });

  it('count out-of-range high', () => {
    expect(() => svc().validatePingParameters(101, 3, 56, 1000)).toThrow();
  });

  it('timeout out-of-range low', () => {
    expect(() => svc().validatePingParameters(5, 0, 56, 1000)).toThrow();
  });

  it('timeout out-of-range high', () => {
    expect(() => svc().validatePingParameters(5, 31, 56, 1000)).toThrow();
  });

  it('packet size out-of-range low', () => {
    expect(() => svc().validatePingParameters(5, 3, -1, 1000)).toThrow();
  });

  it('packet size out-of-range high', () => {
    expect(() => svc().validatePingParameters(5, 3, 70000, 1000)).toThrow();
  });

  it('interval out-of-range high', () => {
    expect(() => svc().validatePingParameters(5, 3, 56, 100000)).toThrow();
  });

  it('non-numeric count throws', () => {
    expect(() => svc().validatePingParameters('abc', 3, 56, 1000)).toThrow();
  });

  it('decimal string for count throws', () => {
    expect(() => svc().validatePingParameters('5.0', 3, 56, 1000)).toThrow();
  });
});

describe('parsePingOutput', () => {
  const SUCCESS = `PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.

--- 10.0.0.1 ping statistics ---
5 packets transmitted, 5 received, 0.0% packet loss, time 4006ms
rtt min/avg/max/mdev = 0.123/0.456/0.789/0.123 ms
`;

  const FAILURE = `PING bad (10.0.0.1) 56(84) bytes of data.

--- bad ping statistics ---
5 packets transmitted, 0 received, 100% packet loss, time 4005ms
`;

  it('parses successful ping', () => {
    const m = parsePingOutput(SUCCESS, 0);
    expect(m.success).toBe(true);
    expect(m.packets_sent).toBe(5);
    expect(m.packets_received).toBe(5);
    expect(m.packet_loss).toBe(0);
    expect(m.reachable).toBe(1);
    expect(m.rtt_avg).toBe(0.456);
  });

  it('parses failed ping (rc=1, all packets lost)', () => {
    const m = parsePingOutput(FAILURE, 1);
    expect(m.success).toBe(true);
    expect(m.reachable).toBe(0);
    expect(m.packet_loss).toBe(100);
  });

  it('parses partial loss', () => {
    const partial = `--- 10.0.0.1 ping statistics ---
5 packets transmitted, 3 received, 40% packet loss, time 4006ms
rtt min/avg/max/mdev = 0.100/0.200/0.300/0.050 ms
`;
    const m = parsePingOutput(partial, 0);
    expect(m.packet_loss).toBe(40);
    expect(m.reachable).toBe(1);
  });

  it('invalid return code marks failure', () => {
    const m = parsePingOutput(SUCCESS, 99);
    expect(m.success).toBe(false);
    expect(m.error).toBeDefined();
  });

  it('malformed output retains default metrics', () => {
    const m = parsePingOutput('garbled output, no stats anywhere', 0);
    expect(m.success).toBe(true);
    expect(m.packets_sent).toBe(0);
    expect(m.rtt_avg).toBeNull();
  });
});

describe('computeExtendedRttStats', () => {
  it('empty samples yield nulls and zero mdev', () => {
    const stats = computeExtendedRttStats([]);
    expect(stats).toEqual({ rtt_min: null, rtt_avg: null, rtt_max: null, rtt_mdev: 0, jitter: null });
  });

  it('single sample: mdev 0, jitter null', () => {
    const stats = computeExtendedRttStats([12.5]);
    expect(stats.rtt_min).toBe(12.5);
    expect(stats.rtt_max).toBe(12.5);
    expect(stats.rtt_avg).toBe(12.5);
    expect(stats.rtt_mdev).toBe(0);
    expect(stats.jitter).toBeNull();
  });

  it('multi-sample computes mean+stdev+jitter', () => {
    const stats = computeExtendedRttStats([10, 12, 14, 16]);
    expect(stats.rtt_min).toBe(10);
    expect(stats.rtt_max).toBe(16);
    expect(stats.rtt_avg).toBe(13);
    expect(stats.jitter).toBe(2);
  });
});

describe('formatPingResponse', () => {
  it('success shape converts ms→sec', () => {
    const metrics: PingMetrics = {
      success: true,
      reachable: 1,
      packet_loss: 0,
      packets_sent: 5,
      packets_received: 5,
      rtt_min: 1,
      rtt_avg: 2,
      rtt_max: 3,
      rtt_mdev: 0.5,
    };
    const resp = formatPingResponse(metrics, '10.0.0.1');
    expect(resp.result).toBe('success');
    expect(resp.target_ip).toBe('10.0.0.1');
    expect(resp.metrics.icmpping).toBe(1);
    expect(resp.metrics.icmppingsec).toBe(0.002);
    expect(resp.metrics['icmppingsec.max']).toBe(0.003);
  });

  it('failure shape carries the error message', () => {
    const metrics: PingMetrics = {
      success: false,
      reachable: 0,
      packet_loss: 100,
      packets_sent: 0,
      packets_received: 0,
      rtt_min: null,
      rtt_avg: null,
      rtt_max: null,
      rtt_mdev: null,
      error: 'Command timed out',
    };
    const resp = formatPingResponse(metrics, '10.0.0.1');
    expect(resp.result).toBe('failure');
    expect(resp.error).toBe('Command timed out');
    expect(resp.metrics.icmppingloss).toBe(100);
  });

  it('extended metrics adds jitter_ms when present', () => {
    const metrics: PingMetrics = {
      success: true,
      reachable: 1,
      packet_loss: 0,
      packets_sent: 5,
      packets_received: 5,
      rtt_min: 1,
      rtt_avg: 2,
      rtt_max: 3,
      rtt_mdev: 0.5,
      jitter: 0.25,
    };
    const resp = formatPingResponse(metrics, '10.0.0.1', true);
    expect(resp.metrics.jitter_ms).toBe(0.25);
  });
});

describe('executeBatchPingTest', () => {
  it('rejects more than 50 targets', async () => {
    const targets = Array.from({ length: 51 }, () => ({ ip: '10.0.0.1' }));
    await expect(
      svc().executeBatchPingTest({
        targets,
        defaultCount: 5,
        defaultTimeout: 3,
        defaultPacketSize: 56,
      }),
    ).rejects.toThrow();
  });
});
