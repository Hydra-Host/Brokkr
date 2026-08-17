import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, access: vi.fn() };
});

import { access } from 'node:fs/promises';
import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { netmaskToCidr, registerBmcCollector } from '../bmc';

const runMock = vi.mocked(run);
const accessMock = vi.mocked(access);
const ctx = {} as never;

interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

interface BmcResult {
  bmc: { ipv4: string | null; mac: string | null; ipv6: string | null };
}

function lanPrint(ipv4: string, netmask: string): string {
  return `IP Address              : ${ipv4}\nMAC Address             : 00:11:22:33:44:55\nSubnet Mask             : ${netmask}\n`;
}

async function collect(ipv4: string, netmask: string): Promise<BmcResult> {
  runMock.mockImplementation(async (cmd, args) => {
    if (cmd === 'ipmitool' && args?.[0] === 'lan' && args[1] === 'print') {
      return ok(lanPrint(ipv4, netmask));
    }
    return ok('');
  });
  const handler = getHandler('collection.bmc')!.handler;
  return (await handler({}, ctx)) as BmcResult;
}

beforeEach(() => {
  runMock.mockReset();
  accessMock.mockReset();
  runMock.mockResolvedValue(ok(''));
  accessMock.mockImplementation(async (path) => {
    if (path === '/dev/ipmi0') return undefined;
    throw new Error('ENOENT');
  });
  clearOperationsForTests();
  registerBmcCollector();
});

describe('netmaskToCidr', () => {
  it('maps valid contiguous masks to their prefix length', () => {
    expect(netmaskToCidr('255.255.255.0')).toBe(24);
    expect(netmaskToCidr('255.255.192.0')).toBe(18);
    expect(netmaskToCidr('0.0.0.0')).toBe(0);
    expect(netmaskToCidr('255.255.255.255')).toBe(32);
  });

  it('returns null for non-contiguous masks', () => {
    expect(netmaskToCidr('255.255.128.128')).toBeNull();
    expect(netmaskToCidr('255.0.255.0')).toBeNull();
    expect(netmaskToCidr('255.255.0.255')).toBeNull();
  });

  it('returns null for malformed masks', () => {
    expect(netmaskToCidr('255.255.255')).toBeNull();
    expect(netmaskToCidr('255.255.255.256')).toBeNull();
    expect(netmaskToCidr('foo')).toBeNull();
    expect(netmaskToCidr('')).toBeNull();
  });
});

describe('collection.bmc', () => {
  it('appends /cidr for a valid netmask', async () => {
    const result = await collect('10.0.0.5', '255.255.255.0');
    expect(result.bmc.ipv4).toBe('10.0.0.5/24');
  });

  it('emits the bare IPv4 for a non-contiguous netmask', async () => {
    const result = await collect('10.0.0.5', '255.255.128.128');
    expect(result.bmc.ipv4).toBe('10.0.0.5');
  });
});
