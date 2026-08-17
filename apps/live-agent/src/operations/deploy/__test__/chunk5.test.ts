import { getOperation } from '@repo/bridge-agent-protocol';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerFstabWriters } from '.././fstab';
import { registerLuksScriptInstaller } from '.././luks';
import { registerMdadmConfigurer } from '.././mdadm';
import { registerWhiteoutRemover } from '.././whiteout';

const runMock = vi.mocked(run);
const ctx = {} as never;

const OK = { exit_code: 0, stdout: '', stderr: '', duration_ms: 0 };

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'deploy-test-'));
  runMock.mockReset();
  clearOperationsForTests();
  registerFstabWriters();
  registerLuksScriptInstaller();
  registerMdadmConfigurer();
  registerWhiteoutRemover();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('deploy.writeFstab', () => {
  it('writes /etc/fstab with mode 0644 and creates the parent dir', async () => {
    const handler = getHandler('deploy.writeFstab')!.handler;
    const result = await handler({ target_path: tmpRoot, content: 'UUID=xxx /boot/efi vfat defaults 0 1\n' }, ctx);
    expect(result).toEqual({ success: true });

    const fstabPath = join(tmpRoot, 'etc', 'fstab');
    const content = await readFile(fstabPath, 'utf-8');
    expect(content).toBe('UUID=xxx /boot/efi vfat defaults 0 1\n');

    const st = await stat(fstabPath);
    expect(st.mode & 0o777).toBe(0o644);
  });
});

describe('deploy.writeCrypttab', () => {
  it('writes /etc/crypttab with mode 0644', async () => {
    const handler = getHandler('deploy.writeCrypttab')!.handler;
    await handler({ target_path: tmpRoot, content: 'data-vol UUID=yyy none luks\n' }, ctx);
    const content = await readFile(join(tmpRoot, 'etc', 'crypttab'), 'utf-8');
    expect(content).toBe('data-vol UUID=yyy none luks\n');

    const st = await stat(join(tmpRoot, 'etc', 'crypttab'));
    expect(st.mode & 0o777).toBe(0o644);
  });
});

describe('deploy.installLuksScripts', () => {
  const VOL = {
    device: '/dev/md0',
    mapper: 'data0',
    mountpoint: '/data0',
    fs_type: 'xfs',
    label: 'data0',
  };

  it('renders + installs all three scripts at /usr/local/bin with mode 0755 from volume params', async () => {
    const handler = getHandler('deploy.installLuksScripts')!.handler;
    const result = (await handler(
      { target_path: tmpRoot, encrypted_volumes: [VOL], rekey_volumes: [VOL], already_keyed: false },
      ctx,
    )) as {
      installed: string[];
    };

    expect(result.installed).toEqual([
      join(tmpRoot, 'usr/local/bin/luks-rekey'),
      join(tmpRoot, 'usr/local/bin/luks-unlock'),
      join(tmpRoot, 'usr/local/bin/luks-lock'),
    ]);

    for (const name of ['luks-rekey', 'luks-unlock', 'luks-lock']) {
      const p = join(tmpRoot, 'usr/local/bin', name);
      const st = await stat(p);
      expect(st.mode & 0o777).toBe(0o755);
      const body = await readFile(p, 'utf-8');
      expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
    }

    const rekey = await readFile(join(tmpRoot, 'usr/local/bin/luks-rekey'), 'utf-8');
    expect(rekey).toContain('/dev/md0');
    expect(rekey).toContain('ALREADY_KEYED=0');
  });

  it('bakes ALREADY_KEYED=1 into the rekey script when already_keyed=true', async () => {
    const handler = getHandler('deploy.installLuksScripts')!.handler;
    await handler({ target_path: tmpRoot, encrypted_volumes: [VOL], rekey_volumes: [VOL], already_keyed: true }, ctx);
    const rekey = await readFile(join(tmpRoot, 'usr/local/bin/luks-rekey'), 'utf-8');
    expect(rekey).toContain('ALREADY_KEYED=1');
  });

  it('schema rejects legacy verbatim script bodies (rekey/unlock/lock strings)', () => {
    const schema = getOperation('deploy.installLuksScripts')!.input;
    const parsed = schema.safeParse({
      target_path: '/target',
      rekey: '#!/bin/bash\nrm -rf /\n',
      unlock: 'x',
      lock: 'x',
    });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects a tampered encrypted_volumes entry (wrong field types)', () => {
    const schema = getOperation('deploy.installLuksScripts')!.input;
    const parsed = schema.safeParse({
      target_path: '/target',
      encrypted_volumes: [{ device: 123, mapper: null }],
      already_keyed: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('writes nothing when input is rejected — no scripts land on disk', async () => {
    const reg = getHandler('deploy.installLuksScripts')!;
    const bad = reg.input.safeParse({
      target_path: tmpRoot,
      rekey: '#!/bin/bash\nrm -rf /\n',
      unlock: 'x',
      lock: 'x',
    });
    expect(bad.success).toBe(false);
    await expect(stat(join(tmpRoot, 'usr/local/bin/luks-rekey'))).rejects.toThrow();
  });

  it('enforces the target-path safety guard (rejects an unsafe target_path)', async () => {
    const handler = getHandler('deploy.installLuksScripts')!.handler;
    await expect(
      handler({ target_path: '/etc', encrypted_volumes: [VOL], already_keyed: false }, ctx),
    ).rejects.toThrow();
    await expect(stat(join('/etc', 'usr/local/bin/luks-rekey'))).rejects.toThrow();
  });
});

describe('deploy.configureMdadm', () => {
  it('returns configured=false when mdadm --scan output is empty', async () => {
    runMock.mockResolvedValue({ ...OK, stdout: '   \n', exit_code: 0 });
    const handler = getHandler('deploy.configureMdadm')!.handler;
    const result = await handler({ target_path: tmpRoot, hostname: 'server1' }, ctx);
    expect(result).toEqual({ configured: false });
  });

  it('substitutes brokkr-discovery with hostname and writes to /etc/mdadm/mdadm.conf', async () => {
    runMock.mockResolvedValue({
      ...OK,
      stdout:
        'ARRAY /dev/md/0 metadata=1.2 name=brokkr-discovery:0 UUID=abc\n' +
        'ARRAY /dev/md/1 metadata=1.2 name=brokkr-discovery:1 UUID=def\n',
    });
    const handler = getHandler('deploy.configureMdadm')!.handler;
    const result = await handler({ target_path: tmpRoot, hostname: 'myhost' }, ctx);
    expect(result).toEqual({ configured: true });

    const written = await readFile(join(tmpRoot, 'etc/mdadm/mdadm.conf'), 'utf-8');
    expect(written).toContain('name=myhost:0');
    expect(written).toContain('name=myhost:1');
    expect(written).not.toContain('brokkr-discovery');
  });

  it('runs `chroot target_path mdadm --detail --scan`', async () => {
    runMock.mockResolvedValue({ ...OK, stdout: '' });
    const handler = getHandler('deploy.configureMdadm')!.handler;
    await handler({ target_path: tmpRoot, hostname: 'h' }, ctx);

    const call = runMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call![0]).toBe('chroot');
    expect(call![1]).toEqual([tmpRoot, 'mdadm', '--detail', '--scan']);
  });

  it('treats non-zero exit with empty stdout as "no arrays" (configured=false)', async () => {
    runMock.mockResolvedValue({
      ...OK,
      exit_code: 1,
      stdout: '',
      stderr: 'mdadm: no arrays found',
    });
    const handler = getHandler('deploy.configureMdadm')!.handler;
    const result = await handler({ target_path: tmpRoot, hostname: 'h' }, ctx);
    expect(result).toEqual({ configured: false });
  });
});

describe('deploy.removeWhiteouts', () => {
  it('returns removed=0 when the tree has no whiteout markers', async () => {
    await mkdir(join(tmpRoot, 'a'), { recursive: true });
    await writeFile(join(tmpRoot, 'a', 'f.txt'), 'hello');

    const handler = getHandler('deploy.removeWhiteouts')!.handler;
    const result = await handler({ target_path: tmpRoot }, ctx);
    expect(result).toEqual({ removed: 0 });

    const content = await readFile(join(tmpRoot, 'a', 'f.txt'), 'utf-8');
    expect(content).toBe('hello');
  });

});
