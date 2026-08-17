import { access } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { CommandAborted, run } from '../../exec';
import { makeLogger } from '../../logger';
const logger = makeLogger('collection');

const IPMI_PATHS = ['/dev/ipmi0', '/dev/ipmi/0', '/dev/ipmidev/0'];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function extract(pattern: RegExp, text: string): string | null {
  const m = text.match(pattern);
  return m ? (m[1] ?? null) : null;
}

export function netmaskToCidr(netmask: string): number | null {
  const octets = netmask.split('.');
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    const n = Number.parseInt(octet, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) | n;
  }
  const unsigned = value >>> 0;
  const inverted = ~unsigned >>> 0;
  if ((inverted & (inverted + 1)) !== 0) return null;
  let cidr = 0;
  let bits = unsigned;
  while (bits & 0x80000000) {
    cidr += 1;
    bits = (bits << 1) >>> 0;
  }
  return cidr;
}

async function getLanInfo(
  channel: string = '',
): Promise<{ ipv4: string | null; mac: string | null; netmask: string | null }> {
  const args = channel ? ['lan', 'print', channel] : ['lan', 'print'];
  const { stdout } = await run('ipmitool', args, { timeout_ms: 30_000 });
  return {
    ipv4: extract(/IP Address\s+:\s+((?:\d{1,3}\.){3}\d{1,3})/, stdout),
    mac: extract(/MAC Address\s+:\s+((?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})/, stdout),
    netmask: extract(/Subnet Mask\s+:\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/, stdout),
  };
}

async function getIpv6(): Promise<string | null> {
  try {
    const { stdout } = await run('ipmitool', ['lan6', 'print'], { timeout_ms: 30_000 });
    for (const match of stdout.matchAll(/Address:\s+([0-9a-fA-F:]+\/\d+)/g)) {
      const addr = match[1];
      if (!addr) continue;
      const ip = (addr.split('/')[0] ?? '').toLowerCase();
      if (ip.startsWith('fe80:') || ip.startsWith('ffff:') || ip === '::') continue;
      return addr;
    }
    return null;
  } catch {
    return null;
  }
}

export function registerBmcCollector(): void {
  registerOperation('collection.bmc', async () => {
    let hasIpmi = false;
    for (const path of IPMI_PATHS) {
      if (await fileExists(path)) {
        hasIpmi = true;
        break;
      }
    }

    if (!hasIpmi) {
      logger.debug('bmc collector: no IPMI device present', { paths: IPMI_PATHS });
      return { bmc: { status: 'no_device' as const, ipv4: null, mac: null, ipv6: null } };
    }

    try {
      let { ipv4, mac, netmask } = await getLanInfo();

      if (ipv4 === '0.0.0.0' || !ipv4) {
        logger.debug('bmc collector: primary channel returned 0.0.0.0, retrying channel 3');
        const ch3 = await getLanInfo('3');
        if (ch3.ipv4 && ch3.ipv4 !== '0.0.0.0') {
          ({ ipv4, mac, netmask } = ch3);
        }
      }

      if (ipv4 && netmask) {
        const cidr = netmaskToCidr(netmask);
        if (cidr !== null) {
          ipv4 = `${ipv4}/${cidr}`;
        } else {
          logger.debug('bmc collector: non-contiguous netmask, emitting bare IPv4', { netmask });
        }
      }

      const ipv6 = await getIpv6();
      return { bmc: { ipv4, mac, ipv6 } };
    } catch (error) {
      if (error instanceof CommandAborted) throw error;
      logger.warn('bmc collector: ipmitool failed', { message: getErrorMessage(error) });
      return {
        bmc: {
          status: 'error' as const,
          error: getErrorMessage(error),
          ipv4: null,
          mac: null,
          ipv6: null,
        },
      };
    }
  });
}
