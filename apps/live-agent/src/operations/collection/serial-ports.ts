import { getErrorMessage } from '@repo/utils';
import { access, readFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('collection');

const IPMI_PATHS = ['/dev/ipmi0', '/dev/ipmi/0', '/dev/ipmidev/0'];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type PlatformInfo = {
  manufacturer: string | null;
  model: string | null;
  architecture: string | null;
};

type PortInfo = {
  hardware_line: number;
  uart_type?: string | undefined;
  hardware_address?: string | undefined;
  irq?: number | undefined;
  hardware_status?: 'active' | 'inactive' | 'unknown' | undefined;
  base_baud?: number | undefined;
  physically_accessible?: boolean | undefined;
};

type SolInfo = {
  sol_capable: boolean;
  sol_enabled?: boolean | undefined;
  hardware_channel?: number | null | undefined;
  hardware_baud_rate?: number | null | undefined;
  hardware_port?: number | null | undefined;
  encryption_capable?: boolean | undefined;
  authentication_capable?: boolean | undefined;
};

async function getPlatformInfo(): Promise<PlatformInfo> {
  const out: PlatformInfo = { manufacturer: null, model: null, architecture: null };
  try {
    const r = await run('dmidecode', ['-s', 'system-manufacturer'], { timeout_ms: 10_000 });
    if (r.exit_code === 0) out.manufacturer = r.stdout.trim();
  } catch (error) {
    logger.debug('dmidecode system-manufacturer failed', { error: getErrorMessage(error) });
  }
  try {
    const r = await run('dmidecode', ['-s', 'system-product-name'], { timeout_ms: 10_000 });
    if (r.exit_code === 0) out.model = r.stdout.trim();
  } catch (error) {
    logger.debug('dmidecode system-product-name failed', { error: getErrorMessage(error) });
  }
  try {
    const r = await run('uname', ['-m'], { timeout_ms: 5_000 });
    if (r.exit_code === 0) out.architecture = r.stdout.trim();
  } catch (error) {
    logger.debug('uname -m failed', { error: getErrorMessage(error) });
  }
  return out;
}

async function readProcSerialInfo(): Promise<Record<number, Partial<PortInfo>>> {
  const info: Record<number, Partial<PortInfo>> = {};
  try {
    const content = await readFile('/proc/tty/driver/serial', 'utf8');
    for (const line of content.trim().split('\n')) {
      const m = line.match(/(\d+):\s+uart:(\S+)\s+port:(\S+)\s+irq:(\d+)/);
      if (!m) continue;
      const [, numStr, uart, addr, irqStr] = m;
      info[Number.parseInt(numStr ?? '0', 10)] = {
        uart_type: uart,
        hardware_address: addr,
        irq: Number.parseInt(irqStr ?? '0', 10),
      };
    }
  } catch (error) {
    logger.debug('serial port proc info read failed', {
      path: '/proc/tty/driver/serial',
      error: getErrorMessage(error),
    });
  }
  return info;
}

async function detectPorts(): Promise<Record<string, PortInfo>> {
  const ports: Record<string, PortInfo> = {};
  const procInfo = await readProcSerialInfo();

  for (let n = 0; n < 4; n++) {
    const device = `/dev/ttyS${n}`;
    const port: PortInfo = { hardware_line: n };
    Object.assign(port, procInfo[n] ?? {});

    try {
      const r = await run('setserial', ['-a', device], { timeout_ms: 5_000 });
      if (r.exit_code === 0) {
        const uartMatch = r.stdout.match(/UART:\s*([^,\n]+)/);
        if (uartMatch) {
          const uart = (uartMatch[1] ?? '').trim();
          port.hardware_status = uart.toLowerCase() === 'unknown' ? 'inactive' : 'active';
        }
        const baudMatch = r.stdout.match(/Baud_base:\s*(\d+)/);
        if (baudMatch?.[1]) port.base_baud = Number.parseInt(baudMatch[1], 10);
      }
    } catch {
      port.hardware_status = 'unknown';
    }

    port.physically_accessible = await pathExists(device);

    ports[`ttyS${n}`] = port;
  }

  return ports;
}

async function getSolInfo(): Promise<SolInfo> {
  const sol: SolInfo = { sol_capable: false };

  let hasIpmi = false;
  for (const p of IPMI_PATHS) {
    if (await pathExists(p)) {
      hasIpmi = true;
      break;
    }
  }
  if (!hasIpmi) return sol;

  try {
    const r = await run('ipmitool', ['sol', 'info'], { timeout_ms: 10_000 });
    if (r.exit_code !== 0) return sol;
    sol.sol_capable = true;

    const enabledMatch = r.stdout.match(/Enabled\s*:\s*(\w+)/);
    sol.sol_enabled = enabledMatch ? (enabledMatch[1] ?? '').toLowerCase() === 'true' : false;

    const channelMatch = r.stdout.match(/Payload Channel\s*:\s*(\d+)/);
    sol.hardware_channel = channelMatch?.[1] ? Number.parseInt(channelMatch[1], 10) : null;

    const baudMatch = r.stdout.match(/Non-Volatile Bit Rate \(kbps\)\s*:\s*([\d.]+)/);
    sol.hardware_baud_rate = baudMatch?.[1] ? Math.round(Number.parseFloat(baudMatch[1]) * 1000) : null;

    const portMatch = r.stdout.match(/Payload Port\s*:\s*(\d+)/);
    sol.hardware_port = portMatch?.[1] ? Number.parseInt(portMatch[1], 10) : null;

    sol.encryption_capable = r.stdout.includes('Force Encryption');
    sol.authentication_capable = r.stdout.includes('Force Authentication');
  } catch (error) {
    logger.debug('ipmitool sol info failed', { error: getErrorMessage(error) });
  }

  return sol;
}

type ResolvedConsole = {
  port: string;
  baud: number;
  source: 'probed' | 'modem_hint' | 'vendor_table' | 'none';
  confirmed: boolean;
  notes: string[];
};

const DEFAULT_BAUD = 115200;

export function resolveSerialConsole(detected: Record<string, PortInfo>, sol: SolInfo): ResolvedConsole | null {
  if (!sol.sol_capable) return null;

  const active = Object.entries(detected)
    .filter(([, p]) => p.physically_accessible !== false && p.hardware_status === 'active')
    .sort((a, b) => a[1].hardware_line - b[1].hardware_line);
  if (active.length === 0) return null;

  const notes: string[] = [];
  const baud = sol.hardware_baud_rate ?? active[0]?.[1].base_baud ?? DEFAULT_BAUD;
  if (sol.hardware_baud_rate == null) notes.push(`BMC SOL reported no baud; using ${baud}`);

  if (active.length === 1) {
    const port = active[0]![0];
    notes.push(`single active UART ${port}`);
    return { port, baud, source: 'modem_hint', confirmed: false, notes };
  }

  const pick = active.find(([n]) => n === 'ttyS1') ?? active.find(([n]) => n === 'ttyS0') ?? active[0]!;
  notes.push(`multiple active UARTs (${active.map(([n]) => n).join(', ')}); chose ${pick[0]} by BMC/COM2 convention`);
  return { port: pick[0], baud, source: 'vendor_table', confirmed: false, notes };
}

export function registerSerialPortsCollector(): void {
  registerOperation('collection.serial_ports', async () => {
    const platform = await getPlatformInfo();
    const detected_ports = await detectPorts();
    const sol = await getSolInfo();

    const ports = Object.fromEntries(Object.entries(detected_ports).filter(([, p]) => p.hardware_status === 'active'));
    const resolved = resolveSerialConsole(detected_ports, sol);

    return {
      serial_ports: {
        hardware_platform: platform,
        detected_ports,
        bmc_sol_hardware: sol,
        ports,
        ...(resolved ? { resolved } : {}),
      },
    };
  });
}
