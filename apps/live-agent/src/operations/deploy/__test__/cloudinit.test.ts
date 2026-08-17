import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { registerCloudInitWriter } from '.././cloudinit';

const ctx = {} as never;

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cloudinit-test-'));
  clearOperationsForTests();
  registerCloudInitWriter();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const payload = {
  cloud_cfg: '# cloud.cfg\n',
  meta_data: 'instance-id: 42\n',
  user_data: '#cloud-config\nhostname: h\n',
  network_config: 'version: 2\n',
  device_id: 'dev-1',
  phone_home_creds: { endpoint: 'https://hub.example/phone-home', deployment_os_token: 'tok-abc' },
};

describe('deploy.writeCloudInitFiles', () => {
  it('writes the cloud-init seed + phone-home script under target_path', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const result = (await handler({ target_path: tmpRoot, ...payload }, ctx)) as { written: string[] };

    expect(result.written).toEqual([
      join(tmpRoot, 'etc/cloud/cloud.cfg'),
      join(tmpRoot, 'var/lib/cloud/seed/nocloud/meta-data'),
      join(tmpRoot, 'var/lib/cloud/seed/nocloud/user-data'),
      join(tmpRoot, 'var/lib/cloud/seed/nocloud/network-config'),
      join(tmpRoot, 'var/lib/brokkr/phone-home-creds.json'),
      join(tmpRoot, 'var/lib/cloud/scripts/per-boot/90-phone-home.sh'),
    ]);

    expect(await readFile(result.written[0]!, 'utf-8')).toBe(payload.cloud_cfg);
    const creds = JSON.parse(await readFile(result.written[4]!, 'utf-8')) as Record<string, unknown>;
    expect(creds).toEqual({ deployment_os_token: 'tok-abc', device_id: 'dev-1' });
    const script = await readFile(result.written[5]!, 'utf-8');
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    expect(script).toContain("'tok-abc'");
    expect(script).toContain("'https://hub.example/phone-home'");
  });

  it('uses 0644 for cloud.cfg + seed files, 0600 for creds, 0700 for the token-bearing script', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await handler({ target_path: tmpRoot, ...payload }, ctx);

    const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

    expect(await modeOf(join(tmpRoot, 'etc/cloud/cloud.cfg'))).toBe(0o644);
    expect(await modeOf(join(tmpRoot, 'var/lib/cloud/seed/nocloud/meta-data'))).toBe(0o644);
    expect(await modeOf(join(tmpRoot, 'var/lib/cloud/seed/nocloud/user-data'))).toBe(0o644);
    expect(await modeOf(join(tmpRoot, 'var/lib/cloud/seed/nocloud/network-config'))).toBe(0o644);
    expect(await modeOf(join(tmpRoot, 'var/lib/brokkr/phone-home-creds.json'))).toBe(0o600);
    expect(await modeOf(join(tmpRoot, 'var/lib/cloud/scripts/per-boot/90-phone-home.sh'))).toBe(0o700);
  });

  it('creates nested parent directories that do not yet exist', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const result = (await handler({ target_path: tmpRoot, ...payload }, ctx)) as { written: string[] };

    for (const p of result.written) {
      await lstat(p);
    }
  });

  it('writes extra_files alongside the core seed (cloud.cfg.d fragments, modes preserved)', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [
      { path: 'etc/cloud/cloud.cfg.d/02-brokkr-roce.cfg', content: '#cloud-config\nwrite_files: []\n', mode: 0o644 },
      { path: 'usr/local/sbin/hydra-roce-ecmp.sh', content: '#!/bin/bash\n# roce\n', mode: 0o755 },
    ];
    const result = (await handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)) as {
      written: string[];
    };

    expect(result.written).toContain(join(tmpRoot, 'etc/cloud/cloud.cfg.d/02-brokkr-roce.cfg'));
    expect(result.written).toContain(join(tmpRoot, 'usr/local/sbin/hydra-roce-ecmp.sh'));
    expect(await readFile(join(tmpRoot, 'etc/cloud/cloud.cfg.d/02-brokkr-roce.cfg'), 'utf-8')).toBe(extras[0]!.content);
    expect((await stat(join(tmpRoot, 'usr/local/sbin/hydra-roce-ecmp.sh'))).mode & 0o777).toBe(0o755);
  });

  it('enforces 0600 on the creds file even when it already exists at 0644 (re-provision)', async () => {
    const credsPath = join(tmpRoot, 'var/lib/brokkr/phone-home-creds.json');
    await mkdir(join(tmpRoot, 'var/lib/brokkr'), { recursive: true });
    await writeFile(credsPath, 'stale', { mode: 0o644 });
    await chmod(credsPath, 0o644);

    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await handler({ target_path: tmpRoot, ...payload }, ctx);

    expect((await stat(credsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credsPath, 'utf-8'))).toEqual({
      deployment_os_token: 'tok-abc',
      device_id: 'dev-1',
    });
  });

  it('rejects malformed cloud.cfg YAML and writes nothing (no partial write)', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await expect(handler({ target_path: tmpRoot, ...payload, cloud_cfg: 'foo: [unclosed' }, ctx)).rejects.toThrow(
      /cloud.cfg is not valid YAML/,
    );

    await expect(access(join(tmpRoot, 'var/lib/brokkr/phone-home-creds.json'))).rejects.toThrow();
    await expect(access(join(tmpRoot, 'etc/cloud/cloud.cfg'))).rejects.toThrow();
  });

  it('rejects a cloud.cfg that parses to a non-mapping scalar', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await expect(handler({ target_path: tmpRoot, ...payload, cloud_cfg: 'just-a-string' }, ctx)).rejects.toThrow(
      /cloud.cfg must be a YAML mapping/,
    );
  });

  it('rejects malformed user-data only when it declares #cloud-config', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await expect(
      handler({ target_path: tmpRoot, ...payload, user_data: '#cloud-config\nfoo: [unclosed' }, ctx),
    ).rejects.toThrow(/user-data is not valid YAML/);
  });

  it('accepts non-YAML user-data forms (shell script, multipart MIME)', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await handler({ target_path: tmpRoot, ...payload, user_data: '#!/bin/sh\nthis: is: not: yaml\n' }, ctx);
    expect(await readFile(join(tmpRoot, 'var/lib/cloud/seed/nocloud/user-data'), 'utf-8')).toBe(
      '#!/bin/sh\nthis: is: not: yaml\n',
    );
  });

  it('renders the per-boot script from the agent template (no bridge-supplied body is written verbatim)', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const result = (await handler({ target_path: tmpRoot, ...payload }, ctx)) as { written: string[] };
    const script = await readFile(join(tmpRoot, 'var/lib/cloud/scripts/per-boot/90-phone-home.sh'), 'utf-8');
    expect(script).not.toContain('rm -rf /');
    expect(script).toContain("DEPLOYMENT_OS_TOKEN='tok-abc'");
    expect(script).toContain('Authorization: Bearer ${DEPLOYMENT_OS_TOKEN}');
    expect(result.written).toContain(join(tmpRoot, 'var/lib/cloud/scripts/per-boot/90-phone-home.sh'));
  });

  it('rejects control-char-laced phone-home creds and writes nothing (no partial write)', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await expect(
      handler(
        {
          target_path: tmpRoot,
          ...payload,
          phone_home_creds: { endpoint: 'https://h/x', deployment_os_token: 'a\nb' },
        },
        ctx,
      ),
    ).rejects.toThrow(/control characters/);
    await expect(access(join(tmpRoot, 'var/lib/cloud/scripts/per-boot/90-phone-home.sh'))).rejects.toThrow();
    await expect(access(join(tmpRoot, 'etc/cloud/cloud.cfg'))).rejects.toThrow();
  });

  it('rejects an over-permissive (0o777) extra_files entry and writes nothing', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [{ path: 'usr/local/sbin/evil.sh', content: '#!/bin/bash\n', mode: 0o777 }];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(
      /disallowed mode/,
    );
    await expect(access(join(tmpRoot, 'etc/cloud/cloud.cfg'))).rejects.toThrow();
    await expect(access(join(tmpRoot, 'usr/local/sbin/evil.sh'))).rejects.toThrow();
  });

  it('rejects an over-sized extra_files entry (per-file cap) and writes nothing', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [{ path: 'etc/big.cfg', content: 'x'.repeat(256 * 1024 + 1), mode: 0o644 }];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(
      /per-file cap/,
    );
    await expect(access(join(tmpRoot, 'etc/cloud/cloud.cfg'))).rejects.toThrow();
  });

  it('rejects an extra_files entry that shadows the agent-rendered per-boot phone-home script', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [
      { path: 'var/lib/cloud/scripts/per-boot/90-phone-home.sh', content: '#!/bin/bash\nrm -rf /\n', mode: 0o755 },
    ];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(
      /reserved agent-owned path/,
    );
    await expect(access(join(tmpRoot, 'var/lib/cloud/scripts/per-boot/90-phone-home.sh'))).rejects.toThrow();
  });

  it('rejects any extra_files entry under the cloud-init per-boot exec dir', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [{ path: 'var/lib/cloud/scripts/per-boot/99-evil.sh', content: '#!/bin/bash\n', mode: 0o755 }];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(
      /reserved agent-owned path/,
    );
    await expect(access(join(tmpRoot, 'var/lib/cloud/scripts/per-boot/99-evil.sh'))).rejects.toThrow();
  });

  it('rejects a ..-laced extra_files entry that resolves onto the per-boot script, writing nothing', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [
      {
        path: 'var/lib/foo/../cloud/scripts/per-boot/90-phone-home.sh',
        content: '#!/bin/bash\nrm -rf /\n',
        mode: 0o755,
      },
    ];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(
      /'\.' or '\.\.' path segments/,
    );
    await expect(access(join(tmpRoot, 'var/lib/cloud/scripts/per-boot/90-phone-home.sh'))).rejects.toThrow();
  });

  it('rejects a leading-slash (absolute) extra_files entry and writes nothing', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [{ path: '/etc/cloud/evil.cfg', content: 'x', mode: 0o644 }];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(
      /must be relative/,
    );
    await expect(access(join(tmpRoot, 'etc/cloud/cloud.cfg'))).rejects.toThrow();
  });

  it('rejects an extra_files entry that shadows the 0600 creds sidecar', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [{ path: 'var/lib/brokkr/phone-home-creds.json', content: '{"x":1}', mode: 0o644 }];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(
      /reserved agent-owned path/,
    );
    await expect(access(join(tmpRoot, 'var/lib/brokkr/phone-home-creds.json'))).rejects.toThrow();
  });

  it('rejects duplicate extra_files paths and writes nothing', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = [
      { path: 'etc/cloud/cloud.cfg.d/01.cfg', content: 'a', mode: 0o644 },
      { path: 'etc/cloud/cloud.cfg.d/01.cfg', content: 'b', mode: 0o644 },
    ];
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(/duplicate/);
    await expect(access(join(tmpRoot, 'etc/cloud/cloud.cfg'))).rejects.toThrow();
  });

  it('rejects too many extra_files (count cap) and writes nothing', async () => {
    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    const extras = Array.from({ length: 33 }, (_, i) => ({ path: `etc/f${i}.cfg`, content: '', mode: 0o644 }));
    await expect(handler({ target_path: tmpRoot, ...payload, extra_files: extras }, ctx)).rejects.toThrow(/count cap/);
    await expect(access(join(tmpRoot, 'etc/cloud/cloud.cfg'))).rejects.toThrow();
  });

  it('wipes stale cloud-init state so re-deploys re-run first-boot modules', async () => {
    const staleData = join(tmpRoot, 'var/lib/cloud/data');
    const staleSem = join(tmpRoot, 'var/lib/cloud/sem');
    await mkdir(staleData, { recursive: true });
    await mkdir(staleSem, { recursive: true });
    await writeFile(join(staleData, 'instance-id'), 'old-instance-uuid');
    await writeFile(join(staleSem, 'config_users_groups.amd64'), '');

    const handler = getHandler('deploy.writeCloudInitFiles')!.handler;
    await handler({ target_path: tmpRoot, ...payload }, ctx);

    await expect(access(join(staleData, 'instance-id'))).rejects.toThrow();
    await expect(access(join(staleSem, 'config_users_groups.amd64'))).rejects.toThrow();
    expect(await readFile(join(tmpRoot, 'var/lib/cloud/seed/nocloud/meta-data'), 'utf-8')).toBe(payload.meta_data);
  });
});
