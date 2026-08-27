import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { getErrorMessage } from '@repo/utils';
import { makeLogger } from '../logger';

const logger = makeLogger('lockscreen');

const IPMI_DEVICE_PATHS = ['/dev/ipmi0', '/dev/ipmi/0', '/dev/ipmidev/0'];
const ISO_VERSION_PATH = '/opt/brokkr/iso-version';
const BRIDGE_API_VERSION_PATH = '/opt/brokkr/bridge-api-version';
const ENV_FILE_PATH = '/opt/brokkr/lockscreen.env';
const ISSUE_PATH = '/etc/issue';

interface BmcInfo {
  mac: string | null;
  ipv4: string | null;
  ipv6: string | null;
}

interface NetworkInfo {
  mac: string | null;
  ipv4: string | null;
  ipv6: string | null;
}

function tryExecFile(cmd: string, args: string[] = [], timeout_ms = 10_000): string | null {
  try {
    return execFileSync(cmd, args, { timeout: timeout_ms, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function readRawFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function subnetMaskToCidr(mask: string): number {
  return mask
    .split('.')
    .map((o) => Number(o).toString(2))
    .join('')
    .split('')
    .filter((b) => b === '1').length;
}

function processVersionString(version: string | null): string {
  if (!version) return 'Unknown';
  return version.split(':').pop()?.trim() || 'Unknown';
}

function getBridgeApiVersion(): string {
  const content = readRawFile(BRIDGE_API_VERSION_PATH);
  if (content === null) return 'Unknown';
  return content || 'Unknown';
}

export function readBmc(): BmcInfo {
  const info: BmcInfo = { mac: null, ipv4: null, ipv6: null };

  if (!IPMI_DEVICE_PATHS.some((p) => existsSync(p))) return info;

  const lanOut = tryExecFile('ipmitool', ['lan', 'print']);
  if (lanOut) {
    const macMatch = lanOut.match(/MAC Address\s+:\s+((?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})/);
    if (macMatch) info.mac = macMatch[1]!;

    const ip4Match = lanOut.match(/IP Address\s+:\s+((?:\d{1,3}\.){3}\d{1,3})/);
    const maskMatch = lanOut.match(/Subnet Mask\s+:\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (ip4Match && maskMatch) {
      info.ipv4 = `${ip4Match[1]}/${subnetMaskToCidr(maskMatch[1]!)}`;
    } else if (ip4Match) {
      info.ipv4 = ip4Match[1]!;
    }
  }

  const lan6Out = tryExecFile('ipmitool', ['lan6', 'print']);
  if (lan6Out) {
    const addrs = [...lan6Out.matchAll(/Address:\s+([0-9a-fA-F:]+\/\d+)/g)]
      .map((m) => m[1]!)
      .filter((a) => !a.startsWith('fe80:') && !a.startsWith('ffff:') && a.split('/')[0] !== '::');
    if (addrs.length > 0) info.ipv6 = addrs[0]!;
  }

  return info;
}

export function readNetwork(): NetworkInfo {
  const info: NetworkInfo = { mac: null, ipv4: null, ipv6: null };

  const cmdline = readRawFile('/proc/cmdline');
  if (cmdline) {
    const bootifMatch = cmdline.match(/BOOTIF=([0-9a-fA-F:]+)/);
    if (bootifMatch) info.mac = bootifMatch[1]!;
  }

  const ip4Out = tryExecFile('ip', ['-o', '-4', 'addr', 'show']);

  if (!info.mac) {
    const ipOut = tryExecFile('ip', ['-o', 'link', 'show']);
    if (ipOut && ip4Out) {
      for (const addrLine of ip4Out.split('\n')) {
        const ifMatch = addrLine.match(/^\d+:\s+(\S+)/);
        const ipMatch = addrLine.match(/inet\s+([\d.]+)/);
        if (!ifMatch || !ipMatch) continue;
        const ip = ipMatch[1]!;
        if (ip === '127.0.0.1' || ip.startsWith('169.254') || ip.startsWith('172.17')) continue;
        const escaped = ifMatch[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const macLine = ipOut.split('\n').find((l) => l.match(new RegExp(`^\\d+:\\s+${escaped}\\b`)));
        if (macLine) {
          const m = macLine.match(/link\/ether\s+([0-9a-fA-F:]+)/);
          if (m) {
            info.mac = m[1]!;
            break;
          }
        }
      }
    }
  }
  if (ip4Out) {
    for (const line of ip4Out.split('\n')) {
      const m = line.match(/inet\s+([\d.]+\/\d+)/);
      if (!m) continue;
      const addr = m[1]!.split('/')[0]!;
      if (addr === '127.0.0.1' || addr.startsWith('169.254') || addr.startsWith('172.17')) continue;
      info.ipv4 = m[1]!;
      break;
    }
  }

  const ip6Out = tryExecFile('ip', ['-o', '-6', 'addr', 'show']);
  if (ip6Out) {
    for (const line of ip6Out.split('\n')) {
      const m = line.match(/inet6\s+([0-9a-fA-F:]+\/\d+)/);
      if (!m) continue;
      const addr = m[1]!.split('/')[0]!;
      if (addr.startsWith('fe80') || addr.startsWith('ffff:') || addr === '::1') continue;
      info.ipv6 = m[1]!;
      break;
    }
  }

  return info;
}

function getSystemInfo(): { kernel: string; arch: string } {
  return {
    kernel: tryExecFile('uname', ['-r'], 5_000) ?? 'Unknown',
    arch: tryExecFile('uname', ['-m'], 5_000) ?? 'Unknown',
  };
}

function loadEnvFile(): Record<string, string> {
  const vars: Record<string, string> = {};
  const content = readRawFile(ENV_FILE_PATH);
  if (!content) return vars;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

export function getLockscreenContent(): string {
  const envVars = loadEnvFile();
  const deviceId = process.env.DEVICE_ID ?? envVars['DEVICE_ID'] ?? 'Unknown device ID';
  const jobId = process.env.JOB_ID ?? envVars['JOB_ID'] ?? 'Unknown job ID';

  const { kernel, arch } = getSystemInfo();
  const net = readNetwork();
  const bmc = readBmc();
  const isoVersion = processVersionString(readRawFile(ISO_VERSION_PATH));

  return `
    ______________________________________________________________________________

        B r o k k r  L i v e  O S
    ______________________________________________________________________________

        System Information
            • Kernel             : ${kernel}
            • Architecture       : ${arch}
    ______________________________________________________________________________

        Primary Network Information
            • Primary NIC MAC    : ${net.mac ?? 'Unknown'}
            • Primary IPv4       : ${net.ipv4 ?? 'Not configured'}
            • Primary IPv6       : ${net.ipv6 ?? 'Not configured'}
    ______________________________________________________________________________

        BMC Information
            • BMC MAC            : ${bmc.mac ?? 'Not available'}
            • BMC IPv4           : ${bmc.ipv4 ?? 'Not configured'}
            • BMC IPv6           : ${bmc.ipv6 ?? 'Not configured'}
    ______________________________________________________________________________

        Brokkr Information
            • Live OS Version    : ${isoVersion}
            • Bridge API Version : ${getBridgeApiVersion()}
    ______________________________________________________________________________

        Device Information
            • Device ID          : ${deviceId || 'Unknown'}
            • Job ID             : ${jobId ?? null}
    ______________________________________________________________________________

    `;
}

function md5(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

function writeIssueFile(content: string): void {
  try {
    const startHash = existsSync(ISSUE_PATH) ? md5(readFileSync(ISSUE_PATH, 'utf8')) : null;
    writeFileSync(ISSUE_PATH, content, 'utf8');
    const endHash = md5(content);

    if (startHash !== endHash) {
      // repaint /etc/issue in place on every getty (VGA + serial); restarting a getty resets the tty and drops active SOL sessions
      tryExecFile('agetty', ['--reload'], 5_000);
    }
  } catch (err) {
    logger.warn('failed to write /etc/issue', { error: getErrorMessage(err) });
  }
}

export interface LockscreenOptions {
  interval_ms?: number;
  signal?: AbortSignal;
}

export function startLockscreen(opts: LockscreenOptions = {}): void {
  const envVars = loadEnvFile();
  const rawInterval = process.env.LOCKSCREEN_INTERVAL ?? envVars['LOCKSCREEN_INTERVAL'] ?? '10';
  const intervalSec = opts.interval_ms !== undefined ? opts.interval_ms / 1000 : Number(rawInterval);
  const interval_ms = intervalSec * 1000;

  if (intervalSec <= 0) {
    try {
      const content = getLockscreenContent();
      process.stdout.write(content);
      writeIssueFile(content);
    } catch (err) {
      logger.warn('lockscreen one-shot failed', { error: getErrorMessage(err) });
    }
    return;
  }

  logger.info('lockscreen loop starting', { interval_ms });

  let lastContent = '';
  const signal = opts.signal;

  const tick = () => {
    if (signal?.aborted) return;
    try {
      const content = getLockscreenContent();
      if (content !== lastContent) {
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(content);
        lastContent = content;
        writeIssueFile(content);
      }
    } catch (err) {
      logger.warn('lockscreen tick failed', { error: getErrorMessage(err) });
    }
    if (!signal?.aborted) {
      timer = setTimeout(tick, interval_ms);
    }
  };

  let timer: NodeJS.Timeout;
  tick();

  signal?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      logger.info('lockscreen loop stopped');
    },
    { once: true },
  );
}
