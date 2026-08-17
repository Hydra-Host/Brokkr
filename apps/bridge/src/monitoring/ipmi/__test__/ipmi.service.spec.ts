import { describe, expect, it, vi } from 'vitest';

import {
  IPMIMonitoringService,
  IPMIValidationError,
  type IPMIDeviceLike,
  type IPMIMonitoringServiceDeps,
  type IPMIResultLike,
} from '../ipmi.service';

function result(overrides: Partial<IPMIResultLike> & { ok?: boolean } = {}): IPMIResultLike {
  return {
    ok: overrides.ok ?? true,
    stdout: overrides.stdout ?? 'ok',
    stderr: overrides.stderr ?? '',
    command: overrides.command ?? [],
  };
}

function deviceFactory() {
  const factory: IPMIMonitoringServiceDeps['deviceFactory'] = {
    create: (args) => {
      const make = (cipher: string | null): IPMIDeviceLike => ({
        ip: args.ip,
        username: args.username,
        password: args.password,
        port: args.port,
        cipher,
        jobId: args.jobId,
        withCipher: (c: string | null) => make(c),
      });
      return make(null);
    },
  };
  return factory;
}

function makeDeps(overrides: Partial<IPMIMonitoringServiceDeps> = {}): IPMIMonitoringServiceDeps {
  return {
    deviceFactory: deviceFactory(),
    validators: {
      validateIp: (ip: string) => {
        if (ip === 'invalid.ip') {
          throw new IPMIValidationError(`Invalid IP address format: ${ip}`);
        }
        return ip;
      },
      validateUsername: (u: string) => u,
      validatePort: (p: unknown) => p as number,
      validateIpmiCommand: (parts: readonly string[]) => {
        const head = parts[0]?.toLowerCase();
        if (head === 'raw') {
          throw new IPMIValidationError(`Command '${head}' not allowed`);
        }
        return [...parts];
      },
    },
    ping: { ipmiPing: vi.fn().mockResolvedValue(true) },
    cipher: { getCipherForDevice: vi.fn().mockResolvedValue(null) },
    metrics: { executeMetricsCommand: vi.fn().mockResolvedValue(result()) },
    batch: { executeBatch: vi.fn().mockResolvedValue([]) },
    logger: { debug: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('IPMIMonitoringService.executeIpmiCommand', () => {
  it('emits cipher_used when cipher is present', async () => {
    const deps = makeDeps({
      cipher: { getCipherForDevice: vi.fn().mockResolvedValue('3') },
      metrics: {
        executeMetricsCommand: vi.fn().mockResolvedValue(result({ stdout: 'sensor data' })),
      },
    });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    const wire = await svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', 'sensor list', 623);

    expect(wire.result).toBe('success');
    expect(wire.response).toBe('sensor data');
    expect(wire.target_ip).toBe('192.168.1.100');
    expect(wire.command).toEqual(['sensor', 'list']);
    expect(wire.cipher_used).toBe('3');
  });

  it('omits cipher_used when cipher is null', async () => {
    const deps = makeDeps({
      metrics: {
        executeMetricsCommand: vi.fn().mockResolvedValue(result({ stdout: 'sensor data' })),
      },
    });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    const wire = await svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', 'sensor list');

    expect(wire.result).toBe('success');
    expect(wire.target_ip).toBe('192.168.1.100');
    expect(wire.command).toEqual(['sensor', 'list']);
    expect('cipher_used' in wire).toBe(false);
  });

  it('uses stderr in response on failure', async () => {
    const deps = makeDeps({
      metrics: {
        executeMetricsCommand: vi
          .fn()
          .mockResolvedValue(result({ ok: false, stdout: '', stderr: 'Unable to establish IPMI session' })),
      },
    });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    const wire = await svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', 'sensor list');

    expect(wire.result).toBe('failure');
    expect(wire.response).toBe('Unable to establish IPMI session');
  });

  it('raises IPMIMonitoringError when ping fails', async () => {
    const deps = makeDeps({ ping: { ipmiPing: vi.fn().mockResolvedValue(false) } });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    await expect(svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', 'sensor list')).rejects.toThrow(
      /IPMI ping failed - IP 192\.168\.1\.100 is not reachable/,
    );
  });

  it('propagates IPMIValidationError on invalid IP', async () => {
    const svc = new IPMIMonitoringService(makeDeps(), 'test-job');

    await expect(svc.executeIpmiCommand('invalid.ip', 'admin', 'password', 'sensor list')).rejects.toBeInstanceOf(
      IPMIValidationError,
    );
  });

  it('propagates IPMIValidationError on disallowed command', async () => {
    const svc = new IPMIMonitoringService(makeDeps(), 'test-job');

    await expect(svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', ['raw', '0x06', '0x01'])).rejects.toThrow(
      /Command 'raw' not allowed/,
    );
  });

  it('throws TypeError when command shape is invalid', async () => {
    const svc = new IPMIMonitoringService(makeDeps(), 'test-job');

    await expect(svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', 42 as unknown as string)).rejects.toThrow(
      /Command must be a string or array/,
    );
  });

  it('forwards the timeout to the metrics adapter', async () => {
    const executeMetricsCommand = vi.fn().mockResolvedValue(result());
    const deps = makeDeps({ metrics: { executeMetricsCommand } });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    await svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', 'sensor list', 623, 30);

    expect(executeMetricsCommand).toHaveBeenCalledWith(expect.anything(), ['sensor', 'list'], { timeout: 30 });
  });

  it('passes null timeout when omitted', async () => {
    const executeMetricsCommand = vi.fn().mockResolvedValue(result());
    const deps = makeDeps({ metrics: { executeMetricsCommand } });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    await svc.executeIpmiCommand('192.168.1.100', 'admin', 'password', 'sensor list');

    expect(executeMetricsCommand).toHaveBeenCalledWith(expect.anything(), ['sensor', 'list'], { timeout: null });
  });
});

describe('IPMIMonitoringService.executeBatchIpmiCommands', () => {
  it('emits a wire dict with counts and per-command results', async () => {
    const adapterResults: IPMIResultLike[] = [
      result({ stdout: 'output1', command: ['sensor', 'list'] }),
      result({ stdout: 'output2', command: ['chassis', 'power', 'status'] }),
    ];
    const deps = makeDeps({ batch: { executeBatch: vi.fn().mockResolvedValue(adapterResults) } });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    const wire = await svc.executeBatchIpmiCommands('192.168.1.100', 'admin', 'password', [
      'sensor list',
      'chassis power status',
    ]);

    expect(wire.target_ip).toBe('192.168.1.100');
    expect(wire.total_commands).toBe(2);
    expect(wire.successful).toBe(2);
    expect(wire.failed).toBe(0);
    expect('cipher_used' in wire).toBe(false);
    expect(wire.results[0]?.command).toEqual(['sensor', 'list']);
    expect(wire.results[1]?.command).toEqual(['chassis', 'power', 'status']);
  });

  it('emits cipher_used when cipher is present', async () => {
    const deps = makeDeps({
      cipher: { getCipherForDevice: vi.fn().mockResolvedValue('17') },
      batch: {
        executeBatch: vi.fn().mockResolvedValue([result({ stdout: 'output1' })]),
      },
    });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    const wire = await svc.executeBatchIpmiCommands('192.168.1.100', 'admin', 'password', [['sensor', 'list']]);

    expect(wire.cipher_used).toBe('17');
  });

  it('shapes validation-failure results with the prefix from the adapter', async () => {
    const adapterResults: IPMIResultLike[] = [
      result({ stdout: 'output1', command: ['sensor', 'list'] }),
      result({
        ok: false,
        stdout: '',
        stderr: "Validation error: Command 'raw' not allowed",
        command: ['raw', '0x06', '0x01'],
      }),
    ];
    const deps = makeDeps({ batch: { executeBatch: vi.fn().mockResolvedValue(adapterResults) } });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    const wire = await svc.executeBatchIpmiCommands('192.168.1.100', 'admin', 'password', [
      'sensor list',
      'raw 0x06 0x01',
    ]);

    expect(wire.successful).toBe(1);
    expect(wire.failed).toBe(1);
    expect(wire.results[1]?.result).toBe('failure');
    expect(wire.results[1]?.response.startsWith('Validation error: ')).toBe(true);
    expect(wire.results[1]?.command).toEqual(['raw', '0x06', '0x01']);
  });

  it('rejects batches over the cap', async () => {
    const svc = new IPMIMonitoringService(makeDeps(), 'test-job');

    await expect(
      svc.executeBatchIpmiCommands(
        '192.168.1.100',
        'admin',
        'password',
        Array.from({ length: 21 }, () => 'sensor'),
      ),
    ).rejects.toThrow(/Maximum 20 commands per batch/);
  });

  it('raises IPMIMonitoringError when ping fails', async () => {
    const deps = makeDeps({ ping: { ipmiPing: vi.fn().mockResolvedValue(false) } });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    await expect(svc.executeBatchIpmiCommands('192.168.1.100', 'admin', 'password', ['sensor list'])).rejects.toThrow(
      /IPMI ping failed - IP 192\.168\.1\.100 is not reachable/,
    );
  });

  it('uses each result.command rather than zipping over raw input', async () => {
    const adapterResults: IPMIResultLike[] = [
      result({ stdout: 'sensor-out', command: ['sensor', 'list'] }),
      result({ stdout: 'chassis-out', command: ['chassis', 'power', 'status'] }),
    ];
    const deps = makeDeps({ batch: { executeBatch: vi.fn().mockResolvedValue(adapterResults) } });
    const svc = new IPMIMonitoringService(deps, 'test-job');

    const wire = await svc.executeBatchIpmiCommands('192.168.1.100', 'admin', 'password', [
      'sensor list',
      42,
      ['chassis', 'power', 'status'],
    ]);

    expect(wire.results[0]?.command).toEqual(['sensor', 'list']);
    expect(wire.results[0]?.response).toBe('sensor-out');
    expect(wire.results[1]?.command).toEqual(['chassis', 'power', 'status']);
    expect(wire.results[1]?.response).toBe('chassis-out');
  });
});
