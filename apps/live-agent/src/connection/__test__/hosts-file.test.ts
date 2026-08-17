import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeHostsEntries, parseHostsFileContent, writeBridgeHostsBlock } from '../hosts-file';

describe('writeBridgeHostsBlock', () => {
  let dir: string;
  let hostsPath: string;

  function write(entries: Parameters<typeof writeBridgeHostsBlock>[2]): Promise<void> {
    return writeBridgeHostsBlock(hostsPath, readFileSync(hostsPath, 'utf8'), entries);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-hosts-'));
    hostsPath = join(dir, 'hosts');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a marker block on a clean hosts file', async () => {
    writeFileSync(hostsPath, '127.0.0.1\tlocalhost\n');
    await write([
      { ip: '10.0.0.231', hostname: 'bridge-1' },
      { ip: '10.0.0.232', hostname: 'bridge-2' },
    ]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).toContain('127.0.0.1\tlocalhost');
    expect(out).toContain('# BEGIN BROKKR BRIDGE ENTRIES');
    expect(out).toContain('10.0.0.231\tbridge-1');
    expect(out).toContain('10.0.0.232\tbridge-2');
    expect(out).toContain('# END BROKKR BRIDGE ENTRIES');
  });

  it('skips an injection-style entry and writes valid entries', async () => {
    const original = '127.0.0.1\tlocalhost\n';
    writeFileSync(hostsPath, original);
    await write([
      { ip: '10.0.0.231', hostname: 'bridge-1' },
      { ip: '10.0.0.99', hostname: 'evil\n6.6.6.6 victim.internal' },
    ]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).toContain('10.0.0.231\tbridge-1');
    expect(out).not.toContain('victim.internal');
  });

  it('skips a malformed IP and writes valid entries', async () => {
    const original = '127.0.0.1\tlocalhost\n';
    writeFileSync(hostsPath, original);
    await write([
      { ip: 'not-an-ip', hostname: 'bad' },
      { ip: '10.0.0.231', hostname: 'bridge-1' },
    ]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).not.toContain('not-an-ip');
    expect(out).toContain('10.0.0.231\tbridge-1');
  });

  it('replaces an existing marker block with the new set', async () => {
    writeFileSync(
      hostsPath,
      [
        '127.0.0.1\tlocalhost',
        '# BEGIN BROKKR BRIDGE ENTRIES',
        '10.0.0.99\told-bridge',
        '# END BROKKR BRIDGE ENTRIES',
        '',
      ].join('\n'),
    );
    await write([{ ip: '10.0.0.231', hostname: 'bridge-1' }]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).not.toContain('10.0.0.99');
    expect(out).not.toContain('old-bridge');
    expect(out).toContain('10.0.0.231\tbridge-1');
    expect(out.match(/# BEGIN BROKKR BRIDGE ENTRIES/g)).toHaveLength(1);
    expect(out.match(/# END BROKKR BRIDGE ENTRIES/g)).toHaveLength(1);
  });

  it('preserves comments and non-block content surrounding the markers', async () => {
    writeFileSync(
      hostsPath,
      [
        '# system hosts',
        '127.0.0.1\tlocalhost',
        '::1\tlocalhost ip6-localhost',
        '# BEGIN BROKKR BRIDGE ENTRIES',
        '10.0.0.99\told-bridge',
        '# END BROKKR BRIDGE ENTRIES',
        '10.10.10.10\tcustom-host',
        '',
      ].join('\n'),
    );
    await write([{ ip: '10.0.0.231', hostname: 'bridge-1' }]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).toContain('# system hosts');
    expect(out).toContain('127.0.0.1\tlocalhost');
    expect(out).toContain('::1\tlocalhost ip6-localhost');
    expect(out).toContain('10.10.10.10\tcustom-host');
    expect(out).not.toContain('10.0.0.99');
  });

  it('refuses to rewrite when marker counts disagree (half-written state)', async () => {
    const original = '# BEGIN BROKKR BRIDGE ENTRIES\n10.0.0.99\torphan\n';
    writeFileSync(hostsPath, original);
    await expect(write([{ ip: '10.0.0.231', hostname: 'bridge-1' }])).rejects.toThrow(/marker/i);
    expect(readFileSync(hostsPath, 'utf8')).toBe(original);
  });

  it('removes a malformed existing row and writes valid entries', async () => {
    const original = [
      '127.0.0.1\tlocalhost',
      '# BEGIN BROKKR BRIDGE ENTRIES',
      'not-an-ip\tbridge-1',
      '# END BROKKR BRIDGE ENTRIES',
      '',
    ].join('\n');
    writeFileSync(hostsPath, original);
    await write([{ ip: '10.0.0.231', hostname: 'bridge-1' }]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).not.toContain('not-an-ip');
    expect(out).toContain('10.0.0.231\tbridge-1');
  });

  it('writes atomically — no .brokkr-hosts.* leftovers on success', async () => {
    writeFileSync(hostsPath, '127.0.0.1\tlocalhost\n');
    await write([{ ip: '10.0.0.231', hostname: 'bridge-1' }]);
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.brokkr-hosts.'));
    expect(leftovers).toEqual([]);
  });

  it('writes atomically — temp removed on failure', async () => {
    writeFileSync(hostsPath, '127.0.0.1\tlocalhost\n');
    const unwritable = join(dir, 'nonexistent-subdir', 'hosts');
    await expect(
      writeBridgeHostsBlock(unwritable, '127.0.0.1\tlocalhost\n', [{ ip: '10.0.0.231', hostname: 'bridge-1' }]),
    ).rejects.toThrow();
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.brokkr-hosts.'));
    expect(leftovers).toEqual([]);
  });

  it('handles an empty entries list by writing an empty marker block', async () => {
    writeFileSync(hostsPath, '127.0.0.1\tlocalhost\n');
    await write([]);
    const out = readFileSync(hostsPath, 'utf8');
    expect(out).toContain('127.0.0.1\tlocalhost');
    expect(out).toContain('# BEGIN BROKKR BRIDGE ENTRIES');
    expect(out).toContain('# END BROKKR BRIDGE ENTRIES');
  });
});

describe('parseHostsFileContent', () => {
  it('returns bridge entries and preserves all surrounding lines', () => {
    const parsed = parseHostsFileContent(
      [
        '127.0.0.1\tlocalhost',
        '# BEGIN BROKKR BRIDGE ENTRIES',
        '10.0.0.231\tbridge-1',
        '# END BROKKR BRIDGE ENTRIES',
        '10.10.10.10\tcustom-host',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      entries: [{ ip: '10.0.0.231', hostname: 'bridge-1' }],
      restLines: ['127.0.0.1\tlocalhost', '10.10.10.10\tcustom-host'],
    });
  });

  it('returns null for imbalanced markers', () => {
    expect(parseHostsFileContent('# BEGIN BROKKR BRIDGE ENTRIES\n10.0.0.231\tbridge-1\n')).toBeNull();
  });

  it('skips malformed rows inside the marker block', () => {
    const parsed = parseHostsFileContent(
      [
        '# BEGIN BROKKR BRIDGE ENTRIES',
        'not-an-ip\tbad',
        '10.0.0.231\tbridge-1',
        '# END BROKKR BRIDGE ENTRIES',
      ].join('\n'),
    );

    expect(parsed?.entries).toEqual([{ ip: '10.0.0.231', hostname: 'bridge-1' }]);
  });
});

describe('mergeHostsEntries', () => {
  it('preserves existing hostnames and lets incoming IP values win', () => {
    expect(
      mergeHostsEntries(
        [
          { ip: '10.0.0.231', hostname: 'bridge-1' },
          { ip: '10.0.0.232', hostname: 'bridge-2' },
        ],
        [
          { ip: '10.0.0.241', hostname: 'bridge-1' },
          { ip: '10.0.0.233', hostname: 'bridge-3' },
        ],
      ),
    ).toEqual([
      { ip: '10.0.0.241', hostname: 'bridge-1' },
      { ip: '10.0.0.232', hostname: 'bridge-2' },
      { ip: '10.0.0.233', hostname: 'bridge-3' },
    ]);
  });

  it('keeps an existing entry when its incoming replacement is malformed', () => {
    expect(
      mergeHostsEntries(
        [{ ip: '10.0.0.231', hostname: 'bridge-1' }],
        [
          { ip: 'not-an-ip', hostname: 'bridge-1' },
          { ip: '10.0.0.232', hostname: 'bridge-2' },
        ],
      ),
    ).toEqual([
      { ip: '10.0.0.231', hostname: 'bridge-1' },
      { ip: '10.0.0.232', hostname: 'bridge-2' },
    ]);
  });
});
