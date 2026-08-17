import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IPXE_VALID_ARCHES,
  IPXE_VALID_EXTS,
  IPXE_VALID_TARGETS,
  createIpxeFallbackFunc,
  resolveIpxeFallback,
} from '../tftp-dyn-file.js';

const BINARY_BYTES = Buffer.from('BINARY');

let workDir: string;
let ipxeRoot: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tftp-dyn-file-'));
  ipxeRoot = join(workDir, 'ipxe-builds');
  mkdirSync(join(ipxeRoot, 'amd64'), { recursive: true });
  writeFileSync(join(ipxeRoot, 'amd64', 'ipxe.efi'), BINARY_BYTES);
  writeFileSync(join(workDir, 'secret.efi'), 'SECRET');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function resolve(filename: string) {
  return resolveIpxeFallback(ipxeRoot, filename);
}

describe('resolveIpxeFallback', () => {
  it('resolves canonical filename', () => {
    const f = resolve('ipxe-amd64.efi');
    expect(f).not.toBeNull();
    const buf = f!.read(BINARY_BYTES.length);
    expect(buf.equals(BINARY_BYTES)).toBe(true);
  });

  it('ignores trailing segments (legacy DHCP commit-hash)', () => {
    expect(resolve('ipxe-amd64-abc123.efi')).not.toBeNull();
  });

  it('rejects path traversal in arch', () => {
    expect(resolve('ipxe-..-.efi')).toBeNull();
    expect(resolve('secret-..-.efi')).toBeNull();
  });

  it('rejects path traversal in target', () => {
    expect(resolve('..-amd64.efi')).toBeNull();
  });

  it('rejects traversal via slashes', () => {
    expect(resolve('snponly-../../etc/passwd-.efi')).toBeNull();
  });

  it('rejects unknown target', () => {
    expect(resolve('passwd-amd64.efi')).toBeNull();
  });

  it('rejects non-efi extension', () => {
    expect(resolve('ipxe-amd64.iso')).toBeNull();
    expect(resolve('ipxe-amd64.bin')).toBeNull();
  });

  it('rejects dots inside segments', () => {
    expect(resolve('ipxe-amd64.foo-bar.efi')).toBeNull();
    expect(resolve('ipxe.x-amd64.efi')).toBeNull();
  });

  it('rejects slashes in filename (basename strips dir, leaves stem without arch)', () => {
    expect(resolve('amd64/ipxe.efi')).toBeNull();
  });

  it('returns null when binary is missing', () => {
    expect(resolve('ipxe-arm64.efi')).toBeNull();
  });

  it('returns null on malformed filename', () => {
    expect(resolve('no-extension')).toBeNull();
    expect(resolve('singlename.efi')).toBeNull();
    expect(resolve('')).toBeNull();
  });
});

describe('createIpxeFallbackFunc', () => {
  it('binds resolver to the supplied root provider', () => {
    const dynFile = createIpxeFallbackFunc(() => ipxeRoot);
    const f = dynFile('ipxe-amd64.efi', '127.0.0.1', 12345);
    expect(f).not.toBeNull();
    expect(f!.read(BINARY_BYTES.length).equals(BINARY_BYTES)).toBe(true);
  });

  it('honours raddress/rport for signature parity but ignores them', () => {
    const dynFile = createIpxeFallbackFunc(() => ipxeRoot);
    const a = dynFile('ipxe-amd64.efi', '10.0.0.1', 1);
    const b = dynFile('ipxe-amd64.efi', '10.0.0.2', 2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('calls the root provider on every invocation (no caching)', () => {
    let rootCalls = 0;
    const dynFile = createIpxeFallbackFunc(() => {
      rootCalls += 1;
      return ipxeRoot;
    });
    dynFile('ipxe-amd64.efi', '127.0.0.1', 1);
    dynFile('ipxe-amd64.efi', '127.0.0.1', 2);
    expect(rootCalls).toBe(2);
  });
});

describe('IPXE_VALID_* sets', () => {
  it('exposes the canonical allowlists', () => {
    expect([...IPXE_VALID_TARGETS].sort()).toEqual(['ipxe', 'snp', 'snponly']);
    expect([...IPXE_VALID_ARCHES].sort()).toEqual(['amd64', 'arm64']);
    expect([...IPXE_VALID_EXTS].sort()).toEqual(['efi']);
  });
});
