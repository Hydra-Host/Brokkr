import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

import { discoverIpv4Interfaces, selfInterfaces } from '../bridge-network/self-network';
import { getErrorMessage } from '../common/error-utils';
import { getLogger } from '../logger/logger.service';

const RESOLV_CONF_PATH = '/etc/resolv.conf';

const MAX_NAMESERVERS = 8;

export interface ResolvConfDeps {
  readFile?: (path: string) => string;
  selfIps?: () => string[];
}

function defaultSelfIps(): string[] {
  return selfInterfaces({ clientFacingOnly: false }, discoverIpv4Interfaces).map((iface) => iface.ip);
}

export function readResolvConfNameservers(deps: ResolvConfDeps = {}): string[] {
  const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  const getSelfIps = deps.selfIps ?? defaultSelfIps;

  let contents: string;
  try {
    contents = readFile(RESOLV_CONF_PATH);
  } catch (error) {
    void getLogger().debug(`resolv.conf self-discovery skipped (unreadable): ${getErrorMessage(error)}`);
    return [];
  }

  let selfIps: Set<string>;
  try {
    selfIps = new Set(getSelfIps());
  } catch (error) {
    void getLogger().warning(`resolv.conf self-IP exclusion degraded: ${getErrorMessage(error)}`);
    selfIps = new Set();
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.split(/[#;]/, 1)[0]!.trim();
    if (line.length === 0) continue;
    const match = /^nameserver\s+(\S+)$/.exec(line);
    if (!match) continue;
    const candidate = match[1];
    if (!isIPv4(candidate)) continue;
    if (candidate.startsWith('127.')) continue;
    if (selfIps.has(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
    if (result.length >= MAX_NAMESERVERS) break;
  }
  if (result.length === 0) {
    void getLogger().debug(
      'resolv.conf self-discovery yielded no usable nameservers (all loopback, self-IP, or non-IPv4); falling back to defaults',
    );
  }
  return result;
}
