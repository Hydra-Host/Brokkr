import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

import { makeLogger } from '../logger';

const logger = makeLogger('hosts-file');

const BEGIN_MARKER = '# BEGIN BROKKR BRIDGE ENTRIES';
const END_MARKER = '# END BROKKR BRIDGE ENTRIES';

// Anchored, so embedded newline/CR/tab/space (the /etc/hosts row-injection vector) is rejected.
const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export interface HostsEntry {
  ip: string;
  hostname: string;
}

function isValidHostsEntry(entry: HostsEntry): boolean {
  return isIP(entry.ip) !== 0 && HOSTNAME_RE.test(entry.hostname);
}

function markerCounts(lines: string[]): { begin: number; end: number } {
  const beginCount = lines.filter((line) => line.includes(BEGIN_MARKER)).length;
  const endCount = lines.filter((line) => line.includes(END_MARKER)).length;
  return { begin: beginCount, end: endCount };
}

export function parseHostsFileContent(raw: string): { entries: HostsEntry[]; restLines: string[] } | null {
  const lines = raw.split('\n');
  const counts = markerCounts(lines);
  if (counts.begin !== counts.end) {
    return null;
  }

  const entries: HostsEntry[] = [];
  const restLines: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.includes(BEGIN_MARKER)) {
      inside = true;
      continue;
    }
    if (inside && line.includes(END_MARKER)) {
      inside = false;
      continue;
    }
    if (!inside) {
      restLines.push(line);
      continue;
    }

    const [ip, hostname, ...rest] = line.trim().split(/\s+/);
    const entry = { ip: ip ?? '', hostname: hostname ?? '' };
    if (rest.length !== 0 || !isValidHostsEntry(entry)) {
      logger.warn('skipping malformed bridge hosts row', { row: line });
      continue;
    }
    entries.push(entry);
  }

  return { entries, restLines };
}

export function mergeHostsEntries(
  existing: ReadonlyArray<HostsEntry>,
  incoming: ReadonlyArray<HostsEntry>,
): HostsEntry[] {
  const byHostname = new Map<string, HostsEntry>();
  for (const entry of existing) {
    byHostname.set(entry.hostname, entry);
  }
  for (const entry of incoming) {
    if (!isValidHostsEntry(entry)) {
      logger.warn('skipping malformed bridge hosts entry', { entry });
      continue;
    }
    byHostname.set(entry.hostname, entry);
  }
  return [...byHostname.values()];
}

// Block format must stay in sync with the bridge-side SSH-bootstrap writer.
export async function writeBridgeHostsBlock(hostsPath: string, original: string, entries: HostsEntry[]): Promise<void> {
  const parsed = parseHostsFileContent(original);
  if (parsed === null) {
    const counts = markerCounts(original.split('\n'));
    throw new Error(
      `refusing to rewrite ${hostsPath}: marker imbalance (BEGIN=${counts.begin}, END=${counts.end}) — manual repair required`,
    );
  }

  const out = parsed.restLines;
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  const validEntries = entries.filter((entry) => {
    if (!isValidHostsEntry(entry)) {
      logger.warn('skipping malformed bridge hosts entry', { entry });
      return false;
    }
    return true;
  });

  const block = [BEGIN_MARKER, ...validEntries.map((entry) => `${entry.ip}\t${entry.hostname}`), END_MARKER];
  const final = [...out, '', ...block, ''].join('\n');

  const dir = dirname(hostsPath);
  let tmpDir: string | null = null;
  try {
    tmpDir = await mkdtemp(`${dir}/.brokkr-hosts.`);
    const tmpFile = `${tmpDir}/hosts`;
    await writeFile(tmpFile, final);
    await chmod(tmpFile, 0o644);
    await rename(tmpFile, hostsPath);
  } finally {
    if (tmpDir !== null) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn('failed to remove hosts temp dir', { path: tmpDir, error: String(error) });
      }
    }
  }
}
