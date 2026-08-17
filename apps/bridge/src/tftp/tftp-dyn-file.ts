import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename as pathBasename, join as pathJoin } from 'node:path';

import { logInfo } from '../logger/logger.service.js';

import type { DynFileFunc, TftpFileObject } from './tftp-states.js';

export const IPXE_VALID_TARGETS: ReadonlySet<string> = new Set(['ipxe', 'snp', 'snponly']);
export const IPXE_VALID_ARCHES: ReadonlySet<string> = new Set(['amd64', 'arm64']);
export const IPXE_VALID_EXTS: ReadonlySet<string> = new Set(['efi']);

class IpxeBinaryFileObject implements TftpFileObject {
  private offset = 0;
  private readonly size: number;
  private _closed = false;

  constructor(private readonly fd: number) {
    this.size = fstatSync(fd).size;
  }

  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    closeSync(this.fd);
  }

  read(size: number): Buffer {
    const buf = Buffer.alloc(size);
    const n = readSync(this.fd, buf, 0, size, this.offset);
    this.offset += n;
    return buf.subarray(0, n);
  }

  seekEnd(): void {
    this.offset = this.size;
  }

  seekStart(): void {
    this.offset = 0;
  }

  tell(): number {
    return this.offset;
  }
}

export function resolveIpxeFallback(root: string, filename: string): TftpFileObject | null {
  const base = pathBasename(filename);

  const dotIndex = base.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const stem = base.slice(0, dotIndex);
  const ext = base.slice(dotIndex + 1);

  const segments = stem.split('-');
  if (segments.length < 2) return null;

  const target = segments[0];
  const arch = segments[1];
  if (target === undefined || arch === undefined) return null;

  if (!IPXE_VALID_TARGETS.has(target) || !IPXE_VALID_ARCHES.has(arch) || !IPXE_VALID_EXTS.has(ext)) {
    return null;
  }

  const resolvedPath = pathJoin(root, arch, `${target}.${ext}`);

  if (!existsSync(resolvedPath)) return null;

  void logInfo(`TFTP resolve: ${base} -> ${resolvedPath}`, { appClassName: 'tftp' });

  return new IpxeBinaryFileObject(openSync(resolvedPath, 'r'));
}

export function createIpxeFallbackFunc(rootProvider: () => string): DynFileFunc {
  return (filename: string, _raddress: string, _rport: number): TftpFileObject | null => {
    return resolveIpxeFallback(rootProvider(), filename);
  };
}
