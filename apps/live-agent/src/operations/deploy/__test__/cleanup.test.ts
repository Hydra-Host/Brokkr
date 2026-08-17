import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:timers/promises', async () => {
  const actual = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
  return { ...actual, setTimeout: async () => undefined };
});

import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerPowerCycleCleaner } from '.././cleanup';

const runMock = vi.mocked(run);
const ctx = {} as never;
const OK = { exit_code: 0, stdout: '', stderr: '', duration_ms: 0 };

let tmpRoot: string;

async function fileExists(path: string): Promise<boolean> {
  try {
    await import('node:fs/promises').then((m) => m.access(path));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cleanup-test-'));
  runMock.mockReset();
  runMock.mockResolvedValue(OK);
  clearOperationsForTests();
  registerPowerCycleCleaner();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('deploy.powerCycleCleanup — identity scrub', () => {
  it('removes ssh host keys (private and .pub)', async () => {
    await mkdir(join(tmpRoot, 'etc', 'ssh'), { recursive: true });
    const keys = [
      'ssh_host_rsa_key',
      'ssh_host_rsa_key.pub',
      'ssh_host_ed25519_key',
      'ssh_host_ed25519_key.pub',
      'ssh_host_ecdsa_key',
      'ssh_host_ecdsa_key.pub',
    ];
    for (const k of keys) {
      await writeFile(join(tmpRoot, 'etc', 'ssh', k), 'stale-key-material');
    }
    await writeFile(join(tmpRoot, 'etc', 'ssh', 'ssh_config'), 'Host *\n');

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    for (const k of keys) {
      expect(await fileExists(join(tmpRoot, 'etc', 'ssh', k))).toBe(false);
    }
    expect(await fileExists(join(tmpRoot, 'etc', 'ssh', 'ssh_config'))).toBe(true);
  });

  it('runs truncate -s 0 on /etc/machine-id', async () => {
    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    const truncateCall = runMock.mock.calls.find(
      ([cmd, args]) => cmd === 'truncate' && (args ?? []).includes(join(tmpRoot, 'etc', 'machine-id')),
    );
    expect(truncateCall).toBeDefined();
    expect(truncateCall![1]).toEqual(['-s', '0', join(tmpRoot, 'etc', 'machine-id')]);
  });

  it('removes /var/lib/systemd/random-seed', async () => {
    await mkdir(join(tmpRoot, 'var', 'lib', 'systemd'), { recursive: true });
    await writeFile(join(tmpRoot, 'var', 'lib', 'systemd', 'random-seed'), 'stale-entropy');

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    expect(await fileExists(join(tmpRoot, 'var', 'lib', 'systemd', 'random-seed'))).toBe(false);
  });

  it('removes /var/lib/cloud/instance and /var/lib/cloud/instances', async () => {
    await mkdir(join(tmpRoot, 'var', 'lib', 'cloud', 'instance'), { recursive: true });
    await mkdir(join(tmpRoot, 'var', 'lib', 'cloud', 'instances', 'iid-baked-into-layer'), { recursive: true });
    await writeFile(join(tmpRoot, 'var', 'lib', 'cloud', 'instance', 'datasource'), 'NoCloud');

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    expect(await fileExists(join(tmpRoot, 'var', 'lib', 'cloud', 'instance'))).toBe(false);
    expect(await fileExists(join(tmpRoot, 'var', 'lib', 'cloud', 'instances'))).toBe(false);
  });

  it('removes cloud-init.log and cloud-init-output.log', async () => {
    await mkdir(join(tmpRoot, 'var', 'log'), { recursive: true });
    await writeFile(join(tmpRoot, 'var', 'log', 'cloud-init.log'), 'stale-log');
    await writeFile(join(tmpRoot, 'var', 'log', 'cloud-init-output.log'), 'stale-output');

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    expect(await fileExists(join(tmpRoot, 'var', 'log', 'cloud-init.log'))).toBe(false);
    expect(await fileExists(join(tmpRoot, 'var', 'log', 'cloud-init-output.log'))).toBe(false);
  });

  it('is best-effort — missing paths do not throw', async () => {
    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await expect(handler({ target_path: tmpRoot }, ctx)).resolves.toEqual({ success: true });
  });
});

describe('deploy.powerCycleCleanup — existing behavior preserved', () => {
  it('removes -is-merged children from target root', async () => {
    await writeFile(join(tmpRoot, 'usr-is-merged'), '');
    await writeFile(join(tmpRoot, 'bin-is-merged'), '');
    await writeFile(join(tmpRoot, 'unrelated-file'), 'keep me');

    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    expect(await fileExists(join(tmpRoot, 'usr-is-merged'))).toBe(false);
    expect(await fileExists(join(tmpRoot, 'bin-is-merged'))).toBe(false);
    expect(await fileExists(join(tmpRoot, 'unrelated-file'))).toBe(true);
  });

  it('calls sync + udevadm settle', async () => {
    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    await handler({ target_path: tmpRoot }, ctx);

    const syncCall = runMock.mock.calls.find(([c, a]) => c === 'sync' && (a ?? []).length === 0);
    const settleCall = runMock.mock.calls.find(([c, a]) => c === 'udevadm' && (a ?? []).includes('settle'));
    expect(syncCall).toBeDefined();
    expect(settleCall).toBeDefined();
  });

  it('returns { success: true }', async () => {
    const handler = getHandler('deploy.powerCycleCleanup')!.handler;
    const result = await handler({ target_path: tmpRoot }, ctx);
    expect(result).toEqual({ success: true });
  });
});
