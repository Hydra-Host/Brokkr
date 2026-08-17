import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { matchPowerDmesgEvents, runPowerDiagnostic } from '../power';

const runMock = vi.mocked(run);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'no ups', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('diagnostic.power', () => {
  it('returns power namespace when no UPS tools are available', async () => {
    runMock.mockResolvedValue(fail());

    const result = (await runPowerDiagnostic()) as { power: { status: string } };

    expect(result).toHaveProperty('power');
    expect(typeof result.power.status).toBe('string');
  });

  it('parses upsc + apcaccess output without throwing', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1] === 'upsc -l') return ok('myups\n');
      if (cmd === 'upsc') return ok(['ups.status: OL', 'battery.charge: 100', 'battery.runtime: 1800'].join('\n'));
      if (cmd === '/bin/sh' && args && args[1] === 'apcaccess')
        return ok('STATUS   : ONLINE\nLINEV    : 120.0 Volts\n');
      return fail();
    });

    const result = (await runPowerDiagnostic()) as { power: { status: string } };

    expect(result.power.status).toBeDefined();
  });
});

describe('matchPowerDmesgEvents', () => {
  it('ignores benign ACPI boot noise including ACPI Error / ACPI BIOS Error', () => {
    const benign = [
      'ACPI: Core revision 20210930',
      'ACPI: PM-Timer IO Port: 0x508',
      'acpi PNP0A08:00: _OSC: OS now controls',
      'ACPI Error: Needed type [Reference], found [Integer] (AE_AML_OPERAND_TYPE)',
      'ACPI BIOS Error (bug): Could not resolve symbol [\\_SB.PCI0]',
      'systemd: Reached target Power Management',
    ].join('\n');

    const { events, critical } = matchPowerDmesgEvents(benign);

    expect(events).toEqual([]);
    expect(critical).toEqual([]);
  });

  it('flags genuine power faults and marks the hard faults critical', () => {
    const faults = [
      'thermal_zone0: thermal shutdown initiated',
      'Under-voltage detected! (0x50005)',
      'power_supply BAT0: charging fault detected',
      'mce: critical temperature reached, throttling cpu',
      'UPS battery critical, initiating shutdown',
      'UPS on battery power',
    ].join('\n');

    const { events, critical } = matchPowerDmesgEvents(faults);

    expect(events).toHaveLength(6);
    expect(critical).toHaveLength(5);
    expect(critical.some((l) => l.includes('charging fault'))).toBe(true);
    expect(critical.some((l) => l.includes('critical temperature'))).toBe(true);
    expect(critical.some((l) => l.includes('battery critical'))).toBe(true);
    expect(critical.some((l) => l.includes('on battery power'))).toBe(false);
  });
});
