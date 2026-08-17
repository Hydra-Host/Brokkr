import { describe, expect, it, vi } from 'vitest';

import { IPMIValidationError } from '../../ipmi/validation.js';
import {
  SolPrerequisiteError,
  SolProvisioningService,
  type IPMIDevice,
  type IPMIResult,
  type SolProvisioningDeps,
  type SolProvisioningHandlers,
} from '../sol-provisioning.service.js';

function result(ok: boolean, stdout = '', stderr = ''): IPMIResult {
  return { ok, stdout, stderr, returncode: ok ? 0 : 1, command: [], cipherUsed: '3', durationMs: 5, timedOut: false };
}

const CHANNEL_INFO_OK = 'Channel 0x1 info:\n  Channel Medium Type   : 802.3 LAN\n';
const USER_LIST =
  'ID  Name\t     Callin  Link Auth\tIPMI Msg   Channel Priv Limit\n1   \t     true    false      false      NO ACCESS\n2   admin   true    false      true       ADMINISTRATOR\n';
const SOL_INFO_ENABLED =
  'Set in progress                 : set-complete\nEnabled                         : true\nPrivilege Level                 : OPERATOR\n';
const SOL_INFO_DISABLED = 'Enabled                         : false\nPrivilege Level                 : OPERATOR\n';
const GETACCESS_ADMIN = 'Maximum User IDs     : 10\nPrivilege Level      : ADMINISTRATOR\n';
const GETACCESS_USER = 'Maximum User IDs     : 10\nPrivilege Level      : USER\n';
const PAYLOAD_ENABLED = 'User 2 on channel 1 is enabled\n';
const PAYLOAD_DISABLED = 'User 2 on channel 1 is disabled\n';

function stubBuildBaseCommand(_device: IPMIDevice): readonly string[] {
  return ['ipmitool'];
}

interface FakeState {
  channelInfo?: IPMIResult;
  userList?: IPMIResult;
  getaccess?: IPMIResult;
  solInfo?: IPMIResult;
  payloadStatus?: IPMIResult;
  cacheValue?: string | null;
}

function makeService(state: FakeState = {}): {
  service: SolProvisioningService;
  rawCalls: string[][];
  handlerCalls: string[];
  cacheSets: [string, string][];
  cacheDeletes: string[];
} {
  const rawCalls: string[][] = [];
  const handlerCalls: string[] = [];
  const cacheSets: [string, string][] = [];
  const cacheDeletes: string[] = [];

  const handlers: SolProvisioningHandlers = {
    solInfo: vi.fn(async () => {
      handlerCalls.push('solInfo');
      return state.solInfo ?? result(true, SOL_INFO_ENABLED);
    }),
    solSetEnabled: vi.fn(async () => {
      handlerCalls.push('solSetEnabled');
      return result(true, '');
    }),
    solPayloadStatus: vi.fn(async () => {
      handlerCalls.push('solPayloadStatus');
      return state.payloadStatus ?? result(true, PAYLOAD_ENABLED);
    }),
    solPayloadEnable: vi.fn(async () => {
      handlerCalls.push('solPayloadEnable');
      return result(true, '');
    }),
  };

  const deps: SolProvisioningDeps = {
    cache: {
      get: vi.fn(async () => state.cacheValue ?? null),
      set: vi.fn(async (key: string, value: string) => {
        cacheSets.push([key, value]);
        return true;
      }),
      delete: vi.fn(async (key: string) => {
        cacheDeletes.push(key);
        return 1;
      }),
    },
    getCipher: vi.fn().mockResolvedValue('3'),
    transport: vi.fn(async (command: readonly string[]) => {
      const argv = [...command];
      rawCalls.push(argv);
      if (argv.includes('info')) return state.channelInfo ?? result(true, CHANNEL_INFO_OK);
      if (argv.includes('list')) return state.userList ?? result(true, USER_LIST);
      if (argv.includes('getaccess')) return state.getaccess ?? result(true, GETACCESS_ADMIN);
      return result(false, '', 'unexpected raw command');
    }),
    handlers,
    buildBaseCommand: stubBuildBaseCommand,
  };

  return { service: new SolProvisioningService('job-1', deps), rawCalls, handlerCalls, cacheSets, cacheDeletes };
}

const ARGS = { deviceId: 'dev-1', bmcIp: '10.0.0.9', username: 'admin', password: 'secret' };

describe('SolProvisioningService.ensureSolEnabled', () => {
  it('reports no actions when everything is already enabled', async () => {
    const { service, cacheSets } = makeService();

    const out = await service.ensureSolEnabled(ARGS);

    expect(out).toEqual({
      channel: 1,
      user_id: 2,
      privilege: 'ADMINISTRATOR',
      channel_sol_was_enabled: true,
      user_payload_was_enabled: true,
      actions: [],
    });
    expect(cacheSets).toEqual([['device:dev-1:ipmi:lan_channel', '1']]);
  });

  it('uses the cached channel without probing', async () => {
    const { service, rawCalls } = makeService({ cacheValue: '6' });

    const out = await service.ensureSolEnabled(ARGS);

    expect(out['channel']).toBe(6);
    expect(rawCalls.some((argv) => argv.includes('info'))).toBe(false);
  });

  it('enables channel SOL and user payload when disabled', async () => {
    const { service, handlerCalls } = makeService({
      solInfo: result(true, SOL_INFO_DISABLED),
      payloadStatus: result(true, PAYLOAD_DISABLED),
    });

    const out = await service.ensureSolEnabled(ARGS);

    expect(out['actions']).toEqual(['Enabled SOL on channel 1', 'Enabled SOL payload for user 2 on channel 1']);
    expect(handlerCalls).toContain('solSetEnabled');
    expect(handlerCalls).toContain('solPayloadEnable');
  });

  it('falls back to unconditional payload enable on unsupported firmware', async () => {
    const { service } = makeService({ payloadStatus: result(false, '', 'Invalid command') });

    const out = await service.ensureSolEnabled(ARGS);

    expect(out['actions']).toEqual(['Enabled SOL payload for user 2 on channel 1 (firmware fallback)']);
  });

  it('raises when user privilege is below the channel SOL minimum', async () => {
    const { service } = makeService({ getaccess: result(true, GETACCESS_USER) });

    await expect(service.ensureSolEnabled(ARGS)).rejects.toThrow(/privilege USER is below the channel SOL minimum/);
  });

  it('raises when the user is not found', async () => {
    const { service } = makeService({
      userList: result(true, 'ID  Name\n3   other   true   false   true   OPERATOR\n'),
    });

    await expect(service.ensureSolEnabled(ARGS)).rejects.toThrow(/User 'admin' not found/);
  });

  it('rejects a malicious bmc_ip before building any ipmitool argv', async () => {
    const { service, rawCalls } = makeService();

    await expect(service.ensureSolEnabled({ ...ARGS, bmcIp: '10.0.0.9; rm -rf /' })).rejects.toThrow(
      IPMIValidationError,
    );
    expect(rawCalls).toEqual([]);
  });

  it('rejects a bmc_ip carrying an ipmitool flag', async () => {
    const { service, rawCalls } = makeService();

    await expect(service.ensureSolEnabled({ ...ARGS, bmcIp: '-oProxyCommand=evil' })).rejects.toThrow(
      IPMIValidationError,
    );
    expect(rawCalls).toEqual([]);
  });

  it('rejects a username with shell metacharacters', async () => {
    const { service, rawCalls } = makeService();

    await expect(service.ensureSolEnabled({ ...ARGS, username: 'admin;reboot' })).rejects.toThrow(IPMIValidationError);
    expect(rawCalls).toEqual([]);
  });

  it('self-heals a stale cached channel on invalid-channel errors', async () => {
    let solInfoCalls = 0;
    const cacheDeletes: string[] = [];
    const solInfo = vi.fn(async () => {
      solInfoCalls += 1;
      if (solInfoCalls === 1) {
        return result(false, '', 'Invalid channel: 7');
      }
      return result(true, SOL_INFO_ENABLED);
    });
    const deps: SolProvisioningDeps = {
      cache: {
        get: vi.fn(async () => (cacheDeletes.length > 0 ? null : '7')),
        set: vi.fn().mockResolvedValue(true),
        delete: vi.fn(async (key: string) => {
          cacheDeletes.push(key);
          return 1;
        }),
      },
      getCipher: vi.fn().mockResolvedValue('3'),
      transport: vi.fn(async (command: readonly string[]) => {
        const argv = [...command];
        if (argv.includes('info')) return result(true, CHANNEL_INFO_OK);
        if (argv.includes('list')) return result(true, USER_LIST);
        if (argv.includes('getaccess')) return result(true, GETACCESS_ADMIN);
        return result(false, '', 'unexpected raw command');
      }),
      handlers: {
        solInfo,
        solSetEnabled: vi.fn().mockResolvedValue(result(true, '')),
        solPayloadStatus: vi.fn().mockResolvedValue(result(true, PAYLOAD_ENABLED)),
        solPayloadEnable: vi.fn().mockResolvedValue(result(true, '')),
      },
      buildBaseCommand: stubBuildBaseCommand,
    };
    const svc = new SolProvisioningService('job-1', deps);

    const out = await svc.ensureSolEnabled(ARGS);

    expect(cacheDeletes).toEqual(['device:dev-1:ipmi:lan_channel']);
    expect(out['channel']).toBe(1);
    expect(solInfoCalls).toBe(2);
  });

  it('raises when channel discovery fails entirely', async () => {
    const deps: SolProvisioningDeps = {
      cache: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(true),
        delete: vi.fn().mockResolvedValue(1),
      },
      getCipher: vi.fn().mockResolvedValue('3'),
      transport: vi.fn().mockResolvedValue(result(false, '', 'no dice')),
      handlers: {
        solInfo: vi.fn().mockResolvedValue(result(true, SOL_INFO_ENABLED)),
        solSetEnabled: vi.fn().mockResolvedValue(result(true, '')),
        solPayloadStatus: vi.fn().mockResolvedValue(result(true, PAYLOAD_ENABLED)),
        solPayloadEnable: vi.fn().mockResolvedValue(result(true, '')),
      },
      buildBaseCommand: stubBuildBaseCommand,
    };
    const svc = new SolProvisioningService('job-1', deps);

    await expect(svc.ensureSolEnabled(ARGS)).rejects.toThrow(SolPrerequisiteError);
    await expect(svc.ensureSolEnabled(ARGS)).rejects.toThrow(/Unable to discover LAN channel/);
  });

  it('falls back to lan print iteration when channel info fails', async () => {
    const deps: SolProvisioningDeps = {
      cache: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(true),
        delete: vi.fn().mockResolvedValue(1),
      },
      getCipher: vi.fn().mockResolvedValue('3'),
      transport: vi.fn(async (command: readonly string[]) => {
        const argv = [...command];
        if (argv.includes('info')) return result(false, '', 'not supported');
        if (argv.includes('print')) {
          const channel = argv[argv.length - 1];
          if (channel === '2')
            return result(true, 'Set in Progress         : Set Complete\nIP Address              : 10.0.0.9\n');
          return result(true, 'IP Address              : 0.0.0.0\n');
        }
        if (argv.includes('list')) return result(true, USER_LIST);
        if (argv.includes('getaccess')) return result(true, GETACCESS_ADMIN);
        return result(false, '', 'unexpected raw command');
      }),
      handlers: {
        solInfo: vi.fn().mockResolvedValue(result(true, SOL_INFO_ENABLED)),
        solSetEnabled: vi.fn().mockResolvedValue(result(true, '')),
        solPayloadStatus: vi.fn().mockResolvedValue(result(true, PAYLOAD_ENABLED)),
        solPayloadEnable: vi.fn().mockResolvedValue(result(true, '')),
      },
      buildBaseCommand: stubBuildBaseCommand,
    };
    const svc = new SolProvisioningService('job-1', deps);

    const out = await svc.ensureSolEnabled(ARGS);

    expect(out['channel']).toBe(2);
  });
});
