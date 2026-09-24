import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IcmpService,
  computeExtendedRttStats,
  createIcmpService,
  formatPingResponse,
  parsePingOutput,
  pingBinary,
  resetPingBinary,
  resolvePingBinary,
  type PingMetrics,
} from '../icmp.service';

const spawnedArgv: string[][] = [];
const existingBinaries = new Set<string>();
let probeStdout = '';
let probeExitCode = 0;
let probeSpawnError: Error | null = null;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  kill(): boolean {
    return true;
  }
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    accessSync: (path: string) => {
      if (!existingBinaries.has(path)) throw new Error(`ENOENT: ${path}`);
    },
  };
});

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: readonly string[]) => {
    spawnedArgv.push([cmd, ...args]);
    const child = new FakeChild();
    setImmediate(() => {
      if (probeSpawnError) {
        child.emit('error', probeSpawnError);
        return;
      }
      if (probeStdout.length > 0) child.stdout.emit('data', Buffer.from(probeStdout));
      child.emit('close', probeExitCode, null);
    });
    return child;
  },
}));

const GNU_SINGLE = `PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.

--- 10.0.0.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.044/0.044/0.044/0.000 ms
`;

const BSD_SINGLE = `PING 10.0.0.1 (10.0.0.1): 56 data bytes

--- 10.0.0.1 ping statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.044/0.044/0.044/0.000 ms
`;

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

  it('parses a gnu single-packet reply', () => {
    const m = parsePingOutput(GNU_SINGLE, 0);
    expect(m.success).toBe(true);
    expect(m.packets_sent).toBe(1);
    expect(m.packets_received).toBe(1);
    expect(m.packet_loss).toBe(0);
    expect(m.reachable).toBe(1);
    expect(m.rtt_avg).toBe(0.044);
    expect(m.rtt_mdev).toBe(0);
  });

  it('parses a bsd single-packet reply', () => {
    const m = parsePingOutput(BSD_SINGLE, 0);
    expect(m.success).toBe(true);
    expect(m.packets_sent).toBe(1);
    expect(m.packets_received).toBe(1);
    expect(m.packet_loss).toBe(0);
    expect(m.reachable).toBe(1);
    expect(m.rtt_min).toBe(0.044);
    expect(m.rtt_avg).toBe(0.044);
    expect(m.rtt_max).toBe(0.044);
    expect(m.rtt_mdev).toBe(0);
  });

  it('parses a bsd total loss (rc=2)', () => {
    const m = parsePingOutput('1 packets transmitted, 0 packets received, 100.0% packet loss\n', 2);
    expect(m.success).toBe(true);
    expect(m.reachable).toBe(0);
    expect(m.packet_loss).toBe(100);
  });

  it('command not found (rc=127) marks failure', () => {
    const m = parsePingOutput('', 127);
    expect(m.success).toBe(false);
    expect(m.error).toBeDefined();
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

describe('resolvePingBinary', () => {
  beforeEach(() => {
    existingBinaries.clear();
    resetPingBinary();
  });

  it('prefers /usr/bin/ping', () => {
    for (const path of ['/usr/bin/ping', '/bin/ping', '/sbin/ping']) existingBinaries.add(path);
    expect(resolvePingBinary()).toBe('/usr/bin/ping');
  });

  it('falls back to /bin/ping then /sbin/ping', () => {
    existingBinaries.add('/bin/ping');
    existingBinaries.add('/sbin/ping');
    expect(resolvePingBinary()).toBe('/bin/ping');
    existingBinaries.delete('/bin/ping');
    expect(resolvePingBinary()).toBe('/sbin/ping');
  });

  it('falls back to the bare name when no candidate exists', () => {
    expect(resolvePingBinary()).toBe('ping');
  });

  it('pingBinary memoizes until reset', () => {
    existingBinaries.add('/sbin/ping');
    expect(pingBinary()).toBe('/sbin/ping');
    existingBinaries.add('/usr/bin/ping');
    expect(pingBinary()).toBe('/sbin/ping');
    resetPingBinary();
    expect(pingBinary()).toBe('/usr/bin/ping');
  });
});

describe('ping command composition', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  function setPlatform(value: string): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  function waitArg(argv: readonly string[]): string {
    return argv[argv.indexOf('-W') + 1];
  }

  beforeEach(() => {
    existingBinaries.clear();
    existingBinaries.add('/sbin/ping');
    resetPingBinary();
    spawnedArgv.length = 0;
    probeStdout = BSD_SINGLE;
    probeExitCode = 0;
    probeSpawnError = null;
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('darwin passes -W in milliseconds through the resolved binary', async () => {
    setPlatform('darwin');
    const m = await svc().runPingCommandSecure('10.0.0.1', 1, 3, 56);
    expect(spawnedArgv).toHaveLength(1);
    expect(spawnedArgv[0][3]).toBe('/sbin/ping');
    expect(waitArg(spawnedArgv[0])).toBe('3000');
    expect(m.success).toBe(true);
    expect(m.reachable).toBe(1);
  });

  it('linux passes -W in seconds', async () => {
    setPlatform('linux');
    probeStdout = GNU_SINGLE;
    const m = await svc().runPingCommandSecure('10.0.0.1', 1, 3, 56);
    expect(spawnedArgv[0][3]).toBe('/sbin/ping');
    expect(waitArg(spawnedArgv[0])).toBe('3');
    expect(m.reachable).toBe(1);
  });

  it('extended ping uses the same binary and wait scaling per packet', async () => {
    setPlatform('darwin');
    probeStdout = '64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=0.044 ms\n';
    const m = await svc().runExtendedPingSecure('10.0.0.1', 2, 3, 56, 0);
    expect(spawnedArgv).toHaveLength(2);
    for (const argv of spawnedArgv) {
      expect(argv[3]).toBe('/sbin/ping');
      expect(waitArg(argv)).toBe('3000');
    }
    expect(m.packets_received).toBe(2);
    expect(m.reachable).toBe(1);
  });

  it('a spawn failure marks the probe as not run', async () => {
    probeSpawnError = new Error('spawn ENOENT');
    const m = await svc().runPingCommandSecure('10.0.0.1', 1, 3, 56);
    expect(m.success).toBe(false);
    expect(m.reachable).toBe(0);
  });

  it('a command-not-found exit marks the probe as not run', async () => {
    probeStdout = '';
    probeExitCode = 127;
    const m = await svc().runPingCommandSecure('10.0.0.1', 1, 3, 56);
    expect(m.success).toBe(false);
  });
});
