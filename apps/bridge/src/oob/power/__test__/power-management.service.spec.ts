import { describe, expect, it, vi } from 'vitest';

import { bmcCredentials } from '../../../common/bmc.types';
import { IPMIValidationError } from '../../ipmi/validation.js';
import {
  type IpmiCipherResolverLike,
  type IpmiDeviceFactoryLike,
  type IpmiDeviceLike,
  type IpmiPingerLike,
  type IpmiResultLike,
  type IpmiRetryLike,
  type LoggerLike,
  type PowerHandlersLike,
  type PowerManagementDeps,
  PowerManagementError,
  PowerManagementService,
} from '../power-management.service';

function ipmiResult(ok: boolean, stdout = '', stderr = '', error = ''): IpmiResultLike {
  return { ok, stdout, stderr, error: error || stderr };
}

type RetryFn = IpmiRetryLike['performIpmiWithRetry'];
function mockRetry(impl: RetryFn): ReturnType<typeof vi.fn<RetryFn>> {
  return vi.fn<RetryFn>(impl);
}

function makeDevice(creds: { ip: string; username: string; password: string }): IpmiDeviceLike {
  const base: IpmiDeviceLike = {
    ip: creds.ip,
    username: creds.username,
    password: creds.password,
    withCipher() {
      return base;
    },
  };
  return base;
}

interface Overrides {
  pinger?: Partial<IpmiPingerLike>;
  cipherResolver?: Partial<IpmiCipherResolverLike>;
  powerHandlers?: Partial<PowerHandlersLike>;
  retry?: Partial<IpmiRetryLike>;
}

interface FakeClock {
  monotonic: () => number;
  advance: (seconds: number) => void;
}

function makeClock(): FakeClock {
  let now = 0;
  return {
    monotonic: () => now,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

function makeDeps(overrides: Overrides = {}): { deps: PowerManagementDeps; clock: FakeClock } {
  const clock = makeClock();
  const deviceFactory: IpmiDeviceFactoryLike = {
    create: (args) => makeDevice(args),
  };
  const cipherResolver: IpmiCipherResolverLike = {
    resolveCipher: vi.fn(async () => [true, '3'] as [boolean, string | null]),
    ...overrides.cipherResolver,
  };
  const pinger: IpmiPingerLike = {
    ping: vi.fn(async () => true),
    pingWithRetry: vi.fn(async () => true),
    ...overrides.pinger,
  };
  const powerHandlers: PowerHandlersLike = {
    power: vi.fn(async () => ipmiResult(true, 'Chassis Power is on')),
    powerStatus: vi.fn(async () => 'on'),
    getBootParam: vi.fn(async () => ipmiResult(true, 'Boot Device Selector : Force PXE')),
    ...overrides.powerHandlers,
  };
  const retry: IpmiRetryLike = {
    performIpmiWithRetry: vi.fn(async () => ({ result: 'success', response: 'ok' })),
    ...overrides.retry,
  };
  const logger: LoggerLike = {
    info: vi.fn(async () => undefined),
    warning: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  };
  const sleeper = {
    sleep: vi.fn(async (seconds: number) => {
      clock.advance(seconds);
    }),
  };
  return {
    deps: { deviceFactory, cipherResolver, pinger, powerHandlers, retry, logger, sleeper, clock },
    clock,
  };
}

const CREDS = bmcCredentials('10.0.0.9', 'admin', 'secret');

describe('PowerManagementService.validateCredentials', () => {
  it('succeeds on the first good status', async () => {
    const { deps } = makeDeps();
    const service = new PowerManagementService('job-1', deps);
    expect(await service.validateCredentials(CREDS)).toEqual({ ipmi_valid: true });
  });

  it('raises when the BMC is unreachable', async () => {
    const { deps } = makeDeps({ pinger: { pingWithRetry: vi.fn(async () => false) } });
    const service = new PowerManagementService('job-1', deps);
    await expect(service.validateCredentials(CREDS)).rejects.toThrow(/not reachable/);
  });

  it('retries and raises after exhausting attempts', async () => {
    const power = vi.fn(async () => ipmiResult(false, '', 'auth failed'));
    const { deps } = makeDeps({ powerHandlers: { power } });
    const service = new PowerManagementService('job-1', deps);

    await expect(service.validateCredentials(CREDS, { maxRetries: 2 })).rejects.toThrow(PowerManagementError);
    expect(power).toHaveBeenCalledTimes(2);
  });

  it('caches the resolved device across calls when cipher detection is authoritative', async () => {
    const resolveCipher = vi.fn(async () => [true, '17'] as [boolean, string | null]);
    const { deps } = makeDeps({ cipherResolver: { resolveCipher } });
    const service = new PowerManagementService('job-1', deps);

    await service.validateCredentials(CREDS);
    await service.validateCredentials(CREDS);

    expect(resolveCipher).toHaveBeenCalledTimes(1);
  });

  it('does not cache the device when cipher detection fails', async () => {
    const resolveCipher = vi.fn(async () => [false, null] as [boolean, string | null]);
    const { deps } = makeDeps({ cipherResolver: { resolveCipher } });
    const service = new PowerManagementService('job-1', deps);

    await service.validateCredentials(CREDS);
    await service.validateCredentials(CREDS);

    expect(resolveCipher).toHaveBeenCalledTimes(2);
  });
});

describe('PowerManagementService input validation', () => {
  it('rejects a malicious bmc_ip before contacting the BMC', async () => {
    const pingWithRetry = vi.fn(async () => true);
    const { deps } = makeDeps({ pinger: { pingWithRetry } });
    const service = new PowerManagementService('job-1', deps);
    const creds = bmcCredentials('10.0.0.9; rm -rf /', 'admin', 'secret');

    await expect(service.validateCredentials(creds)).rejects.toThrow(IPMIValidationError);
    expect(pingWithRetry).not.toHaveBeenCalled();
  });

  it('rejects a bmc_ip carrying an ipmitool flag', async () => {
    const { deps } = makeDeps();
    const service = new PowerManagementService('job-1', deps);
    const creds = bmcCredentials('-oProxyCommand=evil', 'admin', 'secret');

    await expect(service.validateCredentials(creds)).rejects.toThrow(IPMIValidationError);
  });

  it('rejects a username with shell metacharacters', async () => {
    const { deps } = makeDeps();
    const service = new PowerManagementService('job-1', deps);
    const creds = bmcCredentials('10.0.0.9', 'admin;reboot', 'secret');

    await expect(service.validateCredentials(creds)).rejects.toThrow(IPMIValidationError);
  });
});

describe('PowerManagementService power off/on', () => {
  it('powerOff is idempotent when already off', async () => {
    const performIpmiWithRetry = vi.fn();
    const { deps } = makeDeps({
      powerHandlers: { powerStatus: vi.fn(async () => 'off') },
      retry: { performIpmiWithRetry },
    });
    const service = new PowerManagementService('job-1', deps);

    expect(await service.powerOff(CREDS)).toEqual({ power_state: 'off', already_off: true });
    expect(performIpmiWithRetry).not.toHaveBeenCalled();
  });

  it('powerOff sends a soft shutdown', async () => {
    const performIpmiWithRetry = mockRetry(async () => ({ result: 'success' }));
    const { deps } = makeDeps({
      powerHandlers: { powerStatus: vi.fn(async () => 'on') },
      retry: { performIpmiWithRetry },
    });
    const service = new PowerManagementService('job-1', deps);

    expect(await service.powerOff(CREDS)).toEqual({ power_state: 'off', method: 'soft' });
    expect(performIpmiWithRetry.mock.calls[0]?.[1]).toBe('soft');
  });

  it('verifyPowerOff verifies a soft shutdown', async () => {
    const powerStatus = vi.fn().mockResolvedValueOnce('on').mockResolvedValueOnce('off');
    const { deps } = makeDeps({ powerHandlers: { powerStatus } });
    const service = new PowerManagementService('job-1', deps);

    const out = await service.verifyPowerOff(CREDS);
    expect(out['verified']).toBe(true);
    expect(out['method']).toBe('soft');
  });

  it('verifyPowerOff escalates to hard power off', async () => {
    const powerStatus = vi.fn(async () => 'on');
    const performIpmiWithRetry = mockRetry(async () => ({ result: 'success' }));
    const { deps } = makeDeps({
      powerHandlers: { powerStatus },
      retry: { performIpmiWithRetry },
    });
    const service = new PowerManagementService('job-1', deps);

    await expect(service.verifyPowerOff(CREDS, { softTimeout: 20, hardTimeout: 20, pollInterval: 10 })).rejects.toThrow(
      /did not power off/,
    );
    expect(performIpmiWithRetry.mock.calls.map((c) => c[1])).toEqual(['off']);
  });

  it('powerOn is idempotent when already on', async () => {
    const performIpmiWithRetry = vi.fn();
    const { deps } = makeDeps({
      powerHandlers: { powerStatus: vi.fn(async () => 'on') },
      retry: { performIpmiWithRetry },
    });
    const service = new PowerManagementService('job-1', deps);

    expect(await service.powerOn(CREDS)).toEqual({ power_state: 'on', already_on: true });
    expect(performIpmiWithRetry).not.toHaveBeenCalled();
  });

  it('verifyPowerOn times out when the server stays off', async () => {
    const { deps } = makeDeps({ powerHandlers: { powerStatus: vi.fn(async () => 'off') } });
    const service = new PowerManagementService('job-1', deps);

    await expect(service.verifyPowerOn(CREDS, { timeout: 30, pollInterval: 10 })).rejects.toThrow(/did not power on/);
  });
});

describe('PowerManagementService boot device', () => {
  it('setBootDevice dispatches with uefi enabled', async () => {
    const performIpmiWithRetry = mockRetry(async () => ({ result: 'success' }));
    const { deps } = makeDeps({ retry: { performIpmiWithRetry } });
    const service = new PowerManagementService('job-1', deps);

    const out = await service.setBootDevice(CREDS, 'pxe');

    expect(out).toEqual({ device: 'pxe', uefi: true, result: 'success' });
    expect(performIpmiWithRetry.mock.calls[0]?.[1]).toBe('pxe');
    expect(performIpmiWithRetry.mock.calls[0]?.[3]).toEqual({ maxRetries: 3, uefi: true });
  });

  it('verifyBootDevice verifies the selector', async () => {
    const { deps } = makeDeps({
      powerHandlers: {
        getBootParam: vi.fn(async () =>
          ipmiResult(true, 'Options apply to only next boot\n Boot Device Selector : Force PXE\n'),
        ),
      },
    });
    const service = new PowerManagementService('job-1', deps);

    expect(await service.verifyBootDevice(CREDS, 'pxe')).toEqual({ verified: true, device: 'Force PXE' });
  });

  it('verifyBootDevice raises on selector mismatch', async () => {
    const { deps } = makeDeps({
      powerHandlers: {
        getBootParam: vi.fn(async () => ipmiResult(true, 'Boot Device Selector : No override\n')),
      },
    });
    const service = new PowerManagementService('job-1', deps);

    await expect(service.verifyBootDevice(CREDS, 'pxe')).rejects.toThrow(/Boot device mismatch/);
  });

  it('verifyBootDevice reports unparsable output without raising', async () => {
    const { deps } = makeDeps({
      powerHandlers: { getBootParam: vi.fn(async () => ipmiResult(true, 'garbage output')) },
    });
    const service = new PowerManagementService('job-1', deps);

    const out = await service.verifyBootDevice(CREDS, 'pxe');
    expect(out['verified']).toBe(false);
    expect(out['reason']).toBe('could not parse output');
  });

  it('verifyBootDevice raises when the read fails', async () => {
    const { deps } = makeDeps({
      powerHandlers: { getBootParam: vi.fn(async () => ipmiResult(false, '', 'read failed')) },
    });
    const service = new PowerManagementService('job-1', deps);

    await expect(service.verifyBootDevice(CREDS, 'pxe')).rejects.toThrow(/Failed to read boot param 5/);
  });
});

describe('PowerManagementService BMC reset', () => {
  it('bmcResetCold succeeds when the command is accepted', async () => {
    const performIpmiWithRetry = mockRetry(async () => ({ result: 'success' }));
    const { deps } = makeDeps({ retry: { performIpmiWithRetry } });
    const service = new PowerManagementService('job-1', deps);

    expect(await service.bmcResetCold(CREDS)).toEqual({ reset_type: 'cold', result: 'success' });
    expect(performIpmiWithRetry.mock.calls[0]?.[1]).toBe('cold');
  });

  it('bmcResetCold raises on failure', async () => {
    const performIpmiWithRetry = mockRetry(async () => ({ result: 'failure', response: 'mc reset rejected' }));
    const { deps } = makeDeps({ retry: { performIpmiWithRetry } });
    const service = new PowerManagementService('job-1', deps);

    await expect(service.bmcResetCold(CREDS)).rejects.toThrow(/BMC cold reset failed: mc reset rejected/);
  });

  it('verifyBmcRecovery polls until the BMC responds', async () => {
    const ping = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { deps } = makeDeps({ pinger: { ping } });
    const service = new PowerManagementService('job-1', deps);

    const out = await service.verifyBmcRecovery(CREDS, { initialDelay: 30, pollInterval: 10, timeout: 300 });

    expect(out['recovered']).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('verifyBmcRecovery raises on timeout', async () => {
    const { deps } = makeDeps({ pinger: { ping: vi.fn(async () => false) } });
    const service = new PowerManagementService('job-1', deps);

    await expect(service.verifyBmcRecovery(CREDS, { initialDelay: 10, pollInterval: 10, timeout: 40 })).rejects.toThrow(
      /did not recover/,
    );
  });
});
