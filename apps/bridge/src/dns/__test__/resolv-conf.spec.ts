import { describe, expect, it } from 'vitest';

import { readResolvConfNameservers } from '../resolv-conf.js';

describe('readResolvConfNameservers', () => {
  it('parses a single nameserver line', () => {
    expect(readResolvConfNameservers({ readFile: () => 'nameserver 192.0.2.1\n', selfIps: () => [] })).toEqual([
      '192.0.2.1',
    ]);
  });

  it('excludes the systemd-resolved loopback stub (127.0.0.53)', () => {
    expect(readResolvConfNameservers({ readFile: () => 'nameserver 127.0.0.53\n', selfIps: () => [] })).toEqual([]);
  });

  it('excludes all 127.0.0.0/8 loopback addresses', () => {
    const contents = 'nameserver 127.0.0.1\nnameserver 127.1.2.3\nnameserver 192.0.2.1\n';
    expect(readResolvConfNameservers({ readFile: () => contents, selfIps: () => [] })).toEqual(['192.0.2.1']);
  });

  it("excludes the bridge's own IPs so it never forwards to itself", () => {
    const contents = 'nameserver 10.0.0.5\nnameserver 192.0.2.1\n';
    expect(readResolvConfNameservers({ readFile: () => contents, selfIps: () => ['10.0.0.5'] })).toEqual(['192.0.2.1']);
  });

  it('rejects non-IPv4 junk and hostnames', () => {
    const contents = [
      'nameserver not-an-ip',
      'nameserver example.com',
      'nameserver 2001:db8::1',
      'nameserver 999.999.999.999',
      'nameserver 192.0.2.1',
    ].join('\n');
    expect(readResolvConfNameservers({ readFile: () => contents, selfIps: () => [] })).toEqual(['192.0.2.1']);
  });

  it('ignores comments and non-nameserver directives', () => {
    const contents = ['# a comment', '; another comment', 'search example.com', 'nameserver 192.0.2.1'].join('\n');
    expect(readResolvConfNameservers({ readFile: () => contents, selfIps: () => [] })).toEqual(['192.0.2.1']);
  });

  it('dedupes repeated nameservers', () => {
    const contents = 'nameserver 192.0.2.1\nnameserver 192.0.2.1\nnameserver 192.0.2.2\n';
    expect(readResolvConfNameservers({ readFile: () => contents, selfIps: () => [] })).toEqual([
      '192.0.2.1',
      '192.0.2.2',
    ]);
  });

  it('caps the parsed count at 8', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `nameserver 192.0.2.${i + 1}`).join('\n');
    const result = readResolvConfNameservers({ readFile: () => lines, selfIps: () => [] });
    expect(result).toHaveLength(8);
    expect(result[0]).toBe('192.0.2.1');
    expect(result[7]).toBe('192.0.2.8');
  });

  it('returns empty (no throw) when the file is unreadable', () => {
    expect(
      readResolvConfNameservers({
        readFile: () => {
          throw new Error('ENOENT');
        },
        selfIps: () => [],
      }),
    ).toEqual([]);
  });

  it('returns empty for an empty file', () => {
    expect(readResolvConfNameservers({ readFile: () => '', selfIps: () => [] })).toEqual([]);
  });

  it('still excludes loopback when self-IP enumeration throws (fail-soft)', () => {
    const contents = 'nameserver 127.0.0.53\nnameserver 192.0.2.1\n';
    expect(
      readResolvConfNameservers({
        readFile: () => contents,
        selfIps: () => {
          throw new Error('enumeration failed');
        },
      }),
    ).toEqual(['192.0.2.1']);
  });

  it('includes self-IP when enumeration throws — caller must tolerate loops or set upstream override', () => {
    const contents = 'nameserver 10.0.0.5\nnameserver 192.0.2.1\n';
    expect(
      readResolvConfNameservers({
        readFile: () => contents,
        selfIps: () => {
          throw new Error('enumeration failed');
        },
      }),
    ).toEqual(['10.0.0.5', '192.0.2.1']);
  });
});
