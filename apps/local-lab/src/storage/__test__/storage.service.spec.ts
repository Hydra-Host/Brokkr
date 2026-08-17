import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assembleDiscoveryItems,
  blobsToItems,
  computeDiscoveryOk,
  listFiles,
  originHostFromBaseUrl,
  readCacheMetadata,
  REQUIRED_DISCOVERY_FILES,
} from '../storage.service';

describe('listFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'list-'));
  mkdirSync(join(dir, 'arm64'));
  writeFileSync(join(dir, 'top.img'), Buffer.alloc(10));
  writeFileSync(join(dir, 'arm64', 'nested.efi'), Buffer.alloc(10));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('recurses into subdirectories and counts every file', () => {
    const items = listFiles(dir);
    expect(items.length).toBe(2);
  });
  it('uses a path relative to the base dir for nested files', () => {
    const names = listFiles(dir)
      .map((i) => i.name)
      .sort();
    expect(names).toEqual(['arm64/nested.efi', 'top.img']);
  });
  it('returns [] for an absent dir', () => {
    expect(listFiles(join(dir, 'nope'))).toEqual([]);
  });
});

describe('originHostFromBaseUrl', () => {
  it('extracts the host', () => {
    expect(originHostFromBaseUrl('https://brokkr.assets.hydra.host/brokkr-live-light')).toBe(
      'brokkr.assets.hydra.host',
    );
  });
  it('returns empty string on garbage', () => {
    expect(originHostFromBaseUrl('not a url')).toBe('');
  });
});

describe('readCacheMetadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sha-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('parses the sha map', () => {
    writeFileSync(join(dir, '.cache_metadata.json'), JSON.stringify({ vmlinuz: { sha256sum: 'abc' } }));
    expect(readCacheMetadata(dir).vmlinuz?.sha256sum).toBe('abc');
  });
  it('returns {} when missing', () => {
    expect(readCacheMetadata(join(dir, 'nope'))).toEqual({});
  });
});

describe('assembleDiscoveryItems', () => {
  it('merges inventory + sha + path + served', () => {
    const inv = [{ arch: 'arm64', files: [{ name: 'vmlinuz', present: true, sizeBytes: 5, mtimeMs: 9 }] }];
    const items = assembleDiscoveryItems(inv, '/base', { arm64: { vmlinuz: 'sha1' } }, { arm64: { vmlinuz: true } });
    expect(items[0]).toEqual({
      name: 'vmlinuz',
      present: true,
      sizeBytes: 5,
      mtimeMs: 9,
      path: '/base/arm64/vmlinuz',
      arch: 'arm64',
      sha256: 'sha1',
      served: true,
    });
  });
});

describe('computeDiscoveryOk', () => {
  const mk = (present: boolean, served: boolean) =>
    REQUIRED_DISCOVERY_FILES.map((name) => ({
      name,
      present,
      sizeBytes: 1,
      mtimeMs: 1,
      path: `/b/arm64/${name}`,
      arch: 'arm64',
      served,
    }));
  it('true when all required present + served', () => {
    expect(computeDiscoveryOk(mk(true, true), 'arm64', REQUIRED_DISCOVERY_FILES)).toBe(true);
  });
  it('false when any not served', () => {
    expect(computeDiscoveryOk(mk(true, false), 'arm64', REQUIRED_DISCOVERY_FILES)).toBe(false);
  });
  it('false when host arch absent', () => {
    expect(computeDiscoveryOk(mk(true, true), 'amd64', REQUIRED_DISCOVERY_FILES)).toBe(false);
  });
});

describe('blobsToItems', () => {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);

  it('maps blobs 1:1 to items, preserving size/mtime/path with a sha256: name', () => {
    const items = blobsToItems([
      { sha: shaA, path: '/cache/a/aa/x', sizeBytes: 100, mtimeMs: 5 },
      { sha: shaB, path: '/cache/b/bb/y', sizeBytes: 50, mtimeMs: 9 },
    ]);
    expect(items[0]).toEqual({
      name: `sha256:${shaA}`,
      present: true,
      sizeBytes: 100,
      mtimeMs: 5,
      path: '/cache/a/aa/x',
      sha256: shaA,
    });
    expect(items.length).toBe(2);
    expect(items.reduce((n, i) => n + i.sizeBytes, 0)).toBe(150);
  });

  it('returns [] for no blobs', () => {
    expect(blobsToItems([])).toEqual([]);
  });
});
