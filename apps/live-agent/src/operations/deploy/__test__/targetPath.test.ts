import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { getOperation } from '@repo/bridge-agent-protocol';

import { _addAllowedRootForTesting, _resetAllowedRootsForTesting, assertTargetPathSafe } from '.././targetPath';

describe('TargetPath schema (protocol)', () => {
  const op = getOperation('deploy.mountChroot');
  if (!op) throw new Error('deploy.mountChroot must be a registered operation');
  const { input } = op;

  const accepts = (p: string) => input.safeParse({ target_path: p }).success;

  it('accepts /target and /mnt base paths', () => {
    expect(accepts('/target')).toBe(true);
    expect(accepts('/mnt')).toBe(true);
  });

  it('accepts legitimate sub-paths', () => {
    expect(accepts('/target/etc/cloud/cloud.cfg')).toBe(true);
    expect(accepts('/mnt/install-42/boot/grub')).toBe(true);
  });

  it('rejects dot-segments that would escape via path.join', () => {
    expect(accepts('/target/..')).toBe(false);
    expect(accepts('/target/../etc')).toBe(false);
    expect(accepts('/mnt/./../etc')).toBe(false);
  });

  it('rejects paths outside /target and /mnt', () => {
    expect(accepts('/etc/cloud')).toBe(false);
    expect(accepts('/tmp/foo')).toBe(false);
    expect(accepts('/')).toBe(false);
  });

  it('rejects a sibling that shares a prefix but not the separator', () => {
    expect(accepts('/targetx')).toBe(false);
    expect(accepts('/mntfoo/bar')).toBe(false);
  });

  it('rejects empty path segments like a trailing double slash', () => {
    expect(accepts('/target//etc')).toBe(false);
    expect(accepts('/target/')).toBe(false);
  });
});

describe('assertTargetPathSafe', () => {
  afterEach(() => {
    _resetAllowedRootsForTesting();
    _addAllowedRootForTesting(tmpdir());
  });

  it('accepts the base roots themselves', () => {
    _resetAllowedRootsForTesting();
    expect(assertTargetPathSafe('/target')).toBe('/target');
    expect(assertTargetPathSafe('/mnt')).toBe('/mnt');
  });

  it('accepts paths strictly beneath the base roots', () => {
    _resetAllowedRootsForTesting();
    expect(assertTargetPathSafe('/target/etc/cloud')).toBe('/target/etc/cloud');
    expect(assertTargetPathSafe('/mnt/install/42')).toBe('/mnt/install/42');
  });

  it('rejects a sibling that shares a prefix but not the separator', () => {
    _resetAllowedRootsForTesting();
    expect(() => assertTargetPathSafe('/targetx')).toThrow(/rejected target_path/);
    expect(() => assertTargetPathSafe('/mntfake')).toThrow(/rejected target_path/);
  });

  it('rejects traversal that resolves outside the allowed roots', () => {
    _resetAllowedRootsForTesting();
    expect(() => assertTargetPathSafe('/target/../etc')).toThrow(/rejected target_path/);
    expect(() => assertTargetPathSafe('/mnt/./../../var')).toThrow(/rejected target_path/);
  });

  it('rejects paths that are never beneath the allowed roots', () => {
    _resetAllowedRootsForTesting();
    expect(() => assertTargetPathSafe('/')).toThrow(/rejected target_path/);
    expect(() => assertTargetPathSafe('/etc')).toThrow(/rejected target_path/);
    expect(() => assertTargetPathSafe('/tmp/foo')).toThrow(/rejected target_path/);
  });

  it('returns the normalised absolute path on success', () => {
    _resetAllowedRootsForTesting();
    expect(assertTargetPathSafe('/target/a/./b')).toBe('/target/a/b');
  });

  it('honours a test-injected extra root', () => {
    _resetAllowedRootsForTesting();
    _addAllowedRootForTesting('/opt/fake-target');
    expect(assertTargetPathSafe('/opt/fake-target/x')).toBe('/opt/fake-target/x');
  });
});
