import { describe, expect, it } from 'vitest';
import { resolveSerialConsole } from '../serial-ports';

const HP_DL360_PORTS = {
  ttyS0: {
    hardware_line: 0,
    uart_type: '16550A',
    hardware_status: 'active' as const,
    base_baud: 115200,
    physically_accessible: true,
  },
  ttyS1: {
    hardware_line: 1,
    uart_type: '16550A',
    hardware_status: 'active' as const,
    base_baud: 115200,
    physically_accessible: true,
  },
  ttyS2: { hardware_line: 2, uart_type: 'unknown', hardware_status: 'inactive' as const, physically_accessible: true },
  ttyS3: { hardware_line: 3, uart_type: 'unknown', hardware_status: 'inactive' as const, physically_accessible: true },
};
const HP_DL360_SOL = {
  sol_capable: true,
  sol_enabled: true,
  hardware_channel: 2,
  hardware_baud_rate: 115200,
  hardware_port: 623,
};

describe('resolveSerialConsole', () => {
  it('picks COM2/ttyS1 by convention when multiple UARTs are active (HP DL360 Gen9)', () => {
    const r = resolveSerialConsole(HP_DL360_PORTS, HP_DL360_SOL);
    expect(r).not.toBeNull();
    expect(r?.port).toBe('ttyS1');
    expect(r?.baud).toBe(115200);
    expect(r?.source).toBe('vendor_table');
    expect(r?.confirmed).toBe(false);
  });

  it('treats a single active UART as hardware evidence (modem_hint)', () => {
    const r = resolveSerialConsole(
      { ttyS0: { hardware_line: 0, hardware_status: 'active', base_baud: 115200, physically_accessible: true } },
      { sol_capable: true, hardware_baud_rate: 57600 },
    );
    expect(r?.port).toBe('ttyS0');
    expect(r?.baud).toBe(57600);
    expect(r?.source).toBe('modem_hint');
  });

  it('returns null when the BMC is not SOL-capable', () => {
    expect(resolveSerialConsole(HP_DL360_PORTS, { sol_capable: false })).toBeNull();
  });

  it('returns null when no UART is active', () => {
    const inactive = { ttyS0: { hardware_line: 0, hardware_status: 'inactive' as const, physically_accessible: true } };
    expect(resolveSerialConsole(inactive, HP_DL360_SOL)).toBeNull();
  });

  it('defaults baud to 115200 when the BMC reports none', () => {
    const r = resolveSerialConsole(HP_DL360_PORTS, { sol_capable: true });
    expect(r?.baud).toBe(115200);
  });
});
