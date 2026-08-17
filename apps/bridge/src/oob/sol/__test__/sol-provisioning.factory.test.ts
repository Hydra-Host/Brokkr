import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextLogger } from '../../../logger/logger.service.js';
import { buildBaseCommand, resetIpmitoolBin } from '../../ipmi/command.js';
import type { IPMIDevice as AdapterIPMIDevice } from '../../ipmi/device.js';
import { SolProvisioningServiceFactory } from '../sol-provisioning.factory.js';

vi.mock('node:child_process');

const CHANNEL_INFO_STDOUT = 'Channel 0x1 info:\n  Channel Medium Type   : 802.3 LAN\n';
const SOL_INFO_STDOUT =
  'Set in progress                 : set-complete\nEnabled                         : true\nPrivilege Level                 : OPERATOR\n';
const USER_LIST_STDOUT =
  'ID  Name\t     Callin  Link Auth\tIPMI Msg   Channel Priv Limit\n2   admin   true    false      true       ADMINISTRATOR\n';
const PAYLOAD_STDOUT = 'User 2 on channel 1 is enabled\n';
const GETACCESS_STDOUT = 'Maximum User IDs     : 10\nPrivilege Level      : ADMINISTRATOR\n';

interface SpawnedCall {
  argv: string[];
}

function fakeChild(stdout: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: Readable;
    stderr: Readable;
    kill: () => boolean;
  };
  child.stdout = Readable.from([Buffer.from(stdout, 'utf8')]);
  child.stderr = Readable.from([]);
  child.kill = () => true;
  setImmediate(() => {
    (child as unknown as EventEmitter).emit('close', 0, null);
  });
  return child;
}

function pickStdout(argv: string[]): string {
  if (argv.includes('sol')) {
    if (argv.includes('info')) return SOL_INFO_STDOUT;
    if (argv.includes('payload') && argv.includes('status')) return PAYLOAD_STDOUT;
    return '';
  }
  if (argv.includes('channel') && argv.includes('info')) return CHANNEL_INFO_STDOUT;
  if (argv.includes('user') && argv.includes('list')) return USER_LIST_STDOUT;
  if (argv.includes('channel') && argv.includes('getaccess')) return GETACCESS_STDOUT;
  return '';
}

function makeRedisStub(): {
  service: { connection: unknown };
  store: Map<string, string>;
  hashes: Map<string, Map<string, string>>;
} {
  const store = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const connection = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return true;
    },
    delete: async (key: string) => (store.delete(key) ? 1 : 0),
    secretHget: async (key: string, field: string) => hashes.get(key)?.get(field) ?? null,
    secretHset: async (key: string, fields: Record<string, string>) => {
      let bucket = hashes.get(key);
      if (bucket === undefined) {
        bucket = new Map<string, string>();
        hashes.set(key, bucket);
      }
      for (const [field, value] of Object.entries(fields)) {
        bucket.set(field, value);
      }
      return true;
    },
  };
  return { service: { connection }, store, hashes };
}

describe('SolProvisioningServiceFactory (wiring)', () => {
  beforeEach(() => {
    process.env.IPMITOOL_BIN = '/usr/bin/ipmitool';
    resetIpmitoolBin();
  });

  afterEach(() => {
    delete process.env.IPMITOOL_BIN;
    resetIpmitoolBin();
    vi.restoreAllMocks();
  });

  it('binds buildBaseCommand from oob/ipmi/command.ts (argv prefix is byte-for-byte canonical)', async () => {
    const { service: redisStub, store } = makeRedisStub();
    store.set('device:bmc-001:bmc:cipher', '3');
    store.set('device:bmc-001:ipmi:lan_channel', '1');

    const spawnedCalls: SpawnedCall[] = [];
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockImplementation(((bin: string, args: readonly string[]) => {
      const argv = [bin, ...args];
      spawnedCalls.push({ argv });
      return fakeChild(pickStdout(argv));
    }) as unknown as typeof spawn);

    const factory = new SolProvisioningServiceFactory(redisStub as never, new ContextLogger());
    const svc = await factory.create('job-77');

    const result = await svc.ensureSolEnabled({
      deviceId: 'bmc-001',
      bmcIp: '10.0.0.9',
      username: 'admin',
      password: 'secret',
      port: 623,
    });

    expect(result.channel).toBe(1);
    expect(result.user_id).toBe(2);
    expect(result.privilege).toBe('ADMINISTRATOR');

    const expectedPrefix = buildBaseCommand({
      ip: '10.0.0.9',
      username: 'admin',
      password: 'secret',
      port: 623,
      cipher: '3',
      jobId: 'job-77',
    } as AdapterIPMIDevice);

    expect(spawnedCalls.length).toBeGreaterThan(0);
    for (const { argv } of spawnedCalls) {
      const stripped = argv[0] === 'timeout' ? argv.slice(3) : argv;
      expect(stripped.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
    }
  });
});
