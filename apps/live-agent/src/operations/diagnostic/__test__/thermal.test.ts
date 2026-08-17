import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn() };
});

import { readFile } from 'node:fs/promises';
import { run } from '../../../exec';
import { runThermalDiagnostic } from '../thermal';

const runMock = vi.mocked(run);
const readFileMock = vi.mocked(readFile);

interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail(stderr = 'command failed'): RunResult {
  return { stdout: '', stderr, exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
  readFileMock.mockReset();
});

interface ThermalResult {
  thermal: {
    status: string;
    sensors_data: Record<string, Record<string, { input: number }>>;
    thermal_metrics: Record<string, number>;
    fan_status: Record<string, unknown>;
    health_assessment: {
      high_temperatures: string[];
      failed_fans: string[];
      thermal_throttling: boolean;
    };
    issues: string[];
    warnings: string[];
  };
}

describe('diagnostic.thermal', () => {
  it('parses temperature sensor lines without throwing (parseSensors regression)', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('sensors -A')) {
        return ok(['coretemp-isa-0000', 'Core 0:        +45.0°C  (high = +80.0, crit = +99.0)'].join('\n'));
      }
      return ok('');
    });

    const result = (await runThermalDiagnostic()) as ThermalResult;

    expect(result.thermal.thermal_metrics).toEqual({ 'coretemp-isa-0000_Core 0': 45 });
    expect(result.thermal.sensors_data['coretemp-isa-0000']).toEqual({ 'Core 0': { input: 45 } });
    expect(result.thermal.status).toBe('healthy');
  });

  it('parses fan RPM lines into fan_status', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('sensors -A')) {
        return ok(['nct6798-isa-0290', 'fan1:        1234 RPM  (min = 0 RPM)'].join('\n'));
      }
      return ok('');
    });

    const result = (await runThermalDiagnostic()) as ThermalResult;

    expect(result.thermal.fan_status).toEqual({ 'nct6798-isa-0290_fan1': 1234 });
    expect(result.thermal.sensors_data['nct6798-isa-0290']).toEqual({ fan1: { input: 1234 } });
  });

  it('parses mixed temperature and fan lines from multiple chips', async () => {
    const sensorsOut = [
      'coretemp-isa-0000',
      'Core 0:        +55.0°C',
      'Core 1:        +57.0°C',
      '',
      'nct6798-isa-0290',
      'CPU_FAN:      1200 RPM',
      'SYS_FAN:      900 RPM',
    ].join('\n');
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('sensors -A')) return ok(sensorsOut);
      return ok('');
    });

    const result = (await runThermalDiagnostic()) as ThermalResult;

    expect(Object.keys(result.thermal.thermal_metrics).sort()).toEqual([
      'coretemp-isa-0000_Core 0',
      'coretemp-isa-0000_Core 1',
    ]);
    expect(Object.keys(result.thermal.fan_status).sort()).toEqual([
      'nct6798-isa-0290_CPU_FAN',
      'nct6798-isa-0290_SYS_FAN',
    ]);
  });

  it('flags critical CPU temperature in health assessment', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('sensors -A')) {
        return ok(['coretemp-isa-0000', 'cpu_temp:      +95.0°C'].join('\n'));
      }
      return ok('');
    });

    const result = (await runThermalDiagnostic()) as ThermalResult;

    expect(result.thermal.status).toBe('critical');
    expect(result.thermal.issues.some((s) => s.includes('exceeds critical threshold'))).toBe(true);
  });

  it('flags warning-band CPU temperature', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('sensors -A')) {
        return ok(['coretemp-isa-0000', 'cpu_temp:      +82.0°C'].join('\n'));
      }
      return ok('');
    });

    const result = (await runThermalDiagnostic()) as ThermalResult;

    expect(result.thermal.status).toBe('warning');
    expect(result.thermal.warnings.some((s) => s.includes('exceeds warning threshold'))).toBe(true);
  });

  it('flags failed fan when /proc/acpi reports off', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('ls -d /proc/acpi/fan/')) {
        return ok('/proc/acpi/fan/FAN0/state\n');
      }
      return ok('');
    });
    readFileMock.mockImplementation(async (path) => {
      if (typeof path === 'string' && path.includes('/proc/acpi/fan/FAN0/state')) return 'status: off\n';
      throw new Error(`ENOENT: ${String(path)}`);
    });

    const result = (await runThermalDiagnostic()) as ThermalResult;

    expect(result.thermal.fan_status['acpi_FAN0']).toBe('status: off');
    expect(result.thermal.health_assessment.failed_fans).toContain('acpi_FAN0');
    expect(result.thermal.status).toBe('critical');
  });

  it('returns healthy with empty metrics when sensors -A fails', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('sensors -A')) return fail();
      return ok('');
    });

    const result = (await runThermalDiagnostic()) as ThermalResult;

    expect(result.thermal.status).toBe('healthy');
    expect(result.thermal.thermal_metrics).toEqual({});
    expect(result.thermal.sensors_data).toEqual({});
  });
});
