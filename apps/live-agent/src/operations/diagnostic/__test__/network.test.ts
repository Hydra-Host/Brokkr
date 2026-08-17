import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { runNetworkDiagnostic } from '../network';

const runMock = vi.mocked(run);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'no iface', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('diagnostic.network', () => {
  it('returns network namespace when ip link returns nothing', async () => {
    runMock.mockResolvedValue(ok(''));

    const result = (await runNetworkDiagnostic()) as { network: { status: string } };

    expect(result).toHaveProperty('network');
    expect(typeof result.network.status).toBe('string');
  });

  it('parses ip link + ethtool output without throwing', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1] === 'ip link show') {
        return ok('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n');
      }
      if (cmd === 'ethtool') {
        return ok(
          'NIC statistics:\n     rx_packets: 1000\n     rx_errors: 0\n     tx_packets: 950\n     tx_errors: 0\n',
        );
      }
      return fail();
    });

    const result = (await runNetworkDiagnostic()) as { network: { status: string } };

    expect(result.network.status).toBeDefined();
  });
});
