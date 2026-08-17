import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BufferedEntry, setLogSink } from '../../logger';
import { refreshHostsFile } from '../grpc-manager';

describe('refreshHostsFile', () => {
  let dir: string;
  let hostsPath: string;
  let captured: BufferedEntry[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-hosts-mgr-'));
    hostsPath = join(dir, 'hosts');
    writeFileSync(hostsPath, '127.0.0.1\tlocalhost\n');
    captured = [];
    setLogSink((e) => captured.push(e));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setLogSink(null);
    vi.restoreAllMocks();
  });

  it('writes the marker block when given non-empty entries', async () => {
    await refreshHostsFile([{ ip: '10.0.0.231', hostname: 'bridge-1' }], hostsPath);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).toContain('# BEGIN BROKKR BRIDGE ENTRIES');
    expect(out).toContain('10.0.0.231\tbridge-1');
    expect(out).toContain('# END BROKKR BRIDGE ENTRIES');
  });

  it('preserves existing bridge entries during a partial update', async () => {
    await refreshHostsFile(
      [
        { ip: '10.0.0.231', hostname: 'bridge-1' },
        { ip: '10.0.0.232', hostname: 'bridge-2' },
      ],
      hostsPath,
    );
    await refreshHostsFile([{ ip: '10.0.0.231', hostname: 'bridge-1' }], hostsPath);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).toContain('10.0.0.231\tbridge-1');
    expect(out).toContain('10.0.0.232\tbridge-2');
  });

  it('replaces the existing IP for the same hostname', async () => {
    await refreshHostsFile([{ ip: '10.0.0.231', hostname: 'bridge-1' }], hostsPath);
    await refreshHostsFile([{ ip: '10.0.0.241', hostname: 'bridge-1' }], hostsPath);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).not.toContain('10.0.0.231\tbridge-1');
    expect(out).toContain('10.0.0.241\tbridge-1');
  });

  it('preserves entries from concurrent refreshes', async () => {
    const first = refreshHostsFile([{ ip: '10.0.0.231', hostname: 'bridge-1' }], hostsPath);
    const second = refreshHostsFile([{ ip: '10.0.0.232', hostname: 'bridge-2' }], hostsPath);
    await Promise.all([first, second]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).toContain('10.0.0.231\tbridge-1');
    expect(out).toContain('10.0.0.232\tbridge-2');
  });

  it('skips the write when given an empty entries list', async () => {
    const before = readFileSync(hostsPath, 'utf8');
    await refreshHostsFile([], hostsPath);
    expect(readFileSync(hostsPath, 'utf8')).toBe(before);
  });

  it('does not throw when the write fails — logs a warn instead', async () => {
    const unwritable = join(dir, 'nonexistent-subdir', 'hosts');
    await expect(refreshHostsFile([{ ip: '10.0.0.231', hostname: 'bridge-1' }], unwritable)).resolves.toBeUndefined();
    const warns = captured.filter((e) => e.log_level === 'warn' && e.message.includes('failed to refresh /etc/hosts'));
    expect(warns.length).toBeGreaterThan(0);
  });

  it('runs a later refresh after a failed queue link', async () => {
    const unwritable = join(dir, 'nonexistent-subdir', 'hosts');
    const failed = refreshHostsFile([{ ip: '10.0.0.231', hostname: 'bridge-1' }], unwritable);
    const later = refreshHostsFile([{ ip: '10.0.0.232', hostname: 'bridge-2' }], hostsPath);
    await Promise.all([failed, later]);
    expect(readFileSync(hostsPath, 'utf8')).toContain('10.0.0.232\tbridge-2');
  });
});
