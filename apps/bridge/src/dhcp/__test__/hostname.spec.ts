import { describe, expect, it } from 'vitest';

import { OPT_FQDN, OPT_HOSTNAME } from '../dhcp-options.js';
import { parseClientHostname } from '../hostname.js';
import type { DhcpMessage } from '../protocol.js';

function message(options: Map<number, Buffer>): DhcpMessage {
  return {
    op: 1,
    htype: 1,
    hlen: 6,
    hops: 0,
    xid: 0x1234,
    secs: 0,
    flags: 0,
    broadcast: false,
    ciaddr: '0.0.0.0',
    yiaddr: '0.0.0.0',
    siaddr: '0.0.0.0',
    giaddr: '0.0.0.0',
    chaddr: '00:0b:82:01:fc:42',
    messageType: 1,
    options,
  };
}

function withHostname(value: Buffer): DhcpMessage {
  return message(new Map([[OPT_HOSTNAME, value]]));
}

function withFqdn(value: Buffer): DhcpMessage {
  return message(new Map([[OPT_FQDN, value]]));
}

function fqdnHeader(flags: number): Buffer {
  return Buffer.from([flags, 0, 0]);
}

function canonicalLabels(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.')) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, 'ascii'));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

describe('parseClientHostname', () => {
  it('reads a simple opt-12 hostname (test 13)', () => {
    expect(parseClientHostname(withHostname(Buffer.from('laptop', 'ascii')))).toBe('laptop');
  });

  it('strips a trailing NUL from opt-12 (broken-MS clients, test 14)', () => {
    expect(parseClientHostname(withHostname(Buffer.from('laptop\0', 'ascii')))).toBe('laptop');
  });

  it('takes the leftmost label from a dotted opt-12 name (test 15)', () => {
    expect(parseClientHostname(withHostname(Buffer.from('laptop.corp.example', 'ascii')))).toBe('laptop');
  });

  it('rewrites underscores to hyphens (test 16)', () => {
    expect(parseClientHostname(withHostname(Buffer.from('my_host', 'ascii')))).toBe('my-host');
  });

  it('lowercases an uppercase opt-12 name (test 17)', () => {
    expect(parseClientHostname(withHostname(Buffer.from('LAPTOP', 'ascii')))).toBe('laptop');
  });

  it('returns null for an empty opt-12 (test 18)', () => {
    expect(parseClientHostname(withHostname(Buffer.alloc(0)))).toBeNull();
  });

  it('returns null for an illegal char, a leading hyphen, and a >63 label (test 19)', () => {
    expect(parseClientHostname(withHostname(Buffer.from('bad!name', 'ascii')))).toBeNull();
    expect(parseClientHostname(withHostname(Buffer.from('-leading', 'ascii')))).toBeNull();
    expect(parseClientHostname(withHostname(Buffer.from('a'.repeat(64), 'ascii')))).toBeNull();
  });

  it('reads an opt-81 canonical (E set) name (test 20)', () => {
    const opt = Buffer.concat([fqdnHeader(0x04), canonicalLabels('printer.lan')]);
    expect(parseClientHostname(withFqdn(opt))).toBe('printer');
  });

  it('reads an opt-81 ASCII (E clear) name (test 21)', () => {
    const opt = Buffer.concat([fqdnHeader(0x00), Buffer.from('printer.lan', 'ascii')]);
    expect(parseClientHostname(withFqdn(opt))).toBe('printer');
  });

  it('strips a trailing NUL from an opt-81 ASCII name (broken-MS clients, test 21b)', () => {
    const opt = Buffer.concat([fqdnHeader(0x00), Buffer.from('printer\0', 'ascii')]);
    expect(parseClientHostname(withFqdn(opt))).toBe('printer');
  });

  it('prefers opt-81 over opt-12 when both are present (test 22)', () => {
    const fqdn = Buffer.concat([fqdnHeader(0x00), Buffer.from('fromfqdn', 'ascii')]);
    const msg = message(
      new Map([
        [OPT_HOSTNAME, Buffer.from('fromhostname', 'ascii')],
        [OPT_FQDN, fqdn],
      ]),
    );
    expect(parseClientHostname(msg)).toBe('fromfqdn');
  });

  it('falls through when opt-81 is shorter than the 3-byte header (test 23)', () => {
    const msg = message(
      new Map([
        [OPT_FQDN, Buffer.from([0x00, 0x00])],
        [OPT_HOSTNAME, Buffer.from('fallback', 'ascii')],
      ]),
    );
    expect(parseClientHostname(msg)).toBe('fallback');
  });

  it('returns null when an opt-81 canonical label length runs past the option end (test 24)', () => {
    const opt = Buffer.concat([fqdnHeader(0x04), Buffer.from([10, 0x61, 0x62])]);
    expect(parseClientHostname(withFqdn(opt))).toBeNull();
  });

  it('caps the assembled wire-name at 254 label octets (B14: leaves room for the root byte)', () => {
    const head = `host.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}`;
    const accepted = Buffer.concat([fqdnHeader(0x04), canonicalLabels(`${head}.${'b'.repeat(56)}`)]);
    const rejected = Buffer.concat([fqdnHeader(0x04), canonicalLabels(`${head}.${'b'.repeat(57)}`)]);
    expect(parseClientHostname(withFqdn(accepted))).toBe('host');
    expect(parseClientHostname(withFqdn(rejected))).toBeNull();
  });

  it('strips multiple trailing NULs from opt-12 (test 25)', () => {
    expect(parseClientHostname(withHostname(Buffer.from('laptop\0\0', 'ascii')))).toBe('laptop');
  });

  it('falls through to opt-12 when a well-sized opt-81 fails to parse (test 26)', () => {
    const msg = message(
      new Map([
        [OPT_FQDN, Buffer.concat([fqdnHeader(0x04), Buffer.from([10, 0x61, 0x62])])],
        [OPT_HOSTNAME, Buffer.from('fallback', 'ascii')],
      ]),
    );
    expect(parseClientHostname(msg)).toBe('fallback');
  });
});
