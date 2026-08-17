import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getHandler, type HandlerContext } from './dispatch/registry';
import { getErrorMessage } from './errors';
import { run } from './exec';
import { registerCollectionOperations } from './operations/collection/index';
import { registerDeployOperations } from './operations/deploy/index';
import { registerStorageOperations } from './operations/storage/index';
import { registerSystemOperations } from './operations/system';

registerSystemOperations();

registerCollectionOperations('audit-0.0.0', '/tmp/brokkr-harness-snapshots');
registerStorageOperations();
registerDeployOperations();

const CTX: HandlerContext = {
  work_id: 'provision',
  job_id: 'provision',
  signal: new AbortController().signal,
  resultDelivered: Promise.resolve(),
  reportProgress: (_pct: number, msg?: string) => {
    if (msg) console.error(`  [progress] ${msg}`);
  },
  emit: async () => {},
};

async function dispatch(op: string, input: unknown): Promise<unknown> {
  const reg = getHandler(op);
  if (!reg) throw new Error(`op not registered: ${op}`);
  const start = Date.now();
  console.error(`\n>>> ${op}`);
  try {
    const result = await reg.handler(input, CTX);
    const dur = Date.now() - start;
    console.error(`<<< ${op} OK (${dur}ms)`);
    return result;
  } catch (error) {
    console.error(`!!! ${op} THREW: ${getErrorMessage(error)}`);
    throw error;
  }
}

const PayloadSchema = z.object({
  device: z.object({
    id: z.string(),
    hostname: z.string(),
    tenant_id: z.number(),
  }),
  storage: z.object({
    disk_layouts: z.array(z.unknown()),
    deploy_curtin_yaml: z.string(),
    target_path: z.string(),
    full_wipe_disks: z.array(z.string()).optional(),
  }),
  deploy: z.object({
    target_path: z.string(),
    arch: z.enum(['amd64', 'arm64']),
    uefi: z.boolean(),
    distro: z.string(),
    hostname: z.string(),
    grub_disks: z.array(z.string()),
    image: z
      .object({
        url: z.string(),
        compression: z.string().optional(),
        sha256: z.string().optional(),
      })
      .passthrough(),
    fstab: z.string(),
    crypttab: z.string(),
    encrypted_volumes: z.array(z.unknown()),
    grub: z.object({
      defaults: z.string(),
      fallback_cfg: z.string().optional(),
      purge_ttys: z.boolean(),
    }),
    cloud_init: z.object({
      cloud_cfg: z.string(),
      meta_data: z.string(),
      user_data: z.string(),
      network_config: z.string(),
      device_id: z.string(),
      phone_home_creds: z.object({ endpoint: z.string(), deployment_os_token: z.string() }),
      extra_files: z.array(z.object({ path: z.string(), content: z.string(), mode: z.number().int() })).optional(),
    }),
    roce_iommu: z.boolean(),
  }),
});
type Payload = z.infer<typeof PayloadSchema>;

// Dedup /boot/efi* entries from curtin's multi-EFI layout; must match the bridge-side output byte-for-byte.
function cleanFstab(raw: string): string {
  const normalized = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const cleaned: string[] = [];
  let efiSeen = false;
  for (const line of normalized.split('\n')) {
    const stripped = line.trim();
    if (stripped.startsWith('#') || stripped.length === 0) {
      cleaned.push(line);
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      cleaned.push(line);
      continue;
    }
    const mountPoint = parts[1]!;
    if (mountPoint.startsWith('/boot/efi')) {
      const normalized = line.replace(mountPoint, '/boot/efi');
      if (efiSeen) {
        cleaned.push(`# ${normalized}`);
      } else {
        efiSeen = true;
        cleaned.push(normalized);
      }
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join('\n') + '\n\n';
}

async function softRun(cmd: string, args: readonly string[], timeout_ms = 60_000): Promise<void> {
  try {
    const r = await run(cmd, args, { timeout_ms });
    if (r.exit_code !== 0) {
      console.error(`  (soft) ${cmd} ${args.join(' ')} → exit=${r.exit_code} ${r.stderr.trim()}`);
    } else if (r.stdout.trim()) {
      console.error(`  (soft) ${cmd} ${args.join(' ')} → ${r.stdout.trim().split('\n')[0]}`);
    }
  } catch (err) {
    console.error(`  (soft) ${cmd} ${args.join(' ')} → exception: ${getErrorMessage(err)}`);
  }
}

async function fullWipe(disks: readonly string[]): Promise<void> {
  console.error('\n==== FULL WIPE: tear down VGs/MDs + superblock-wipe every disk ====');

  // Must come before storage.unmountDisks — chroot keeps /target busy.
  console.error('\n>>> teardown: umount -R /target (chroot bind mounts + target fs)');
  await softRun('umount', ['-R', '/target']);
  await softRun('umount', ['/target']);

  console.error('\n>>> teardown: storage.unmountDisks (best-effort)');
  try {
    const reg = getHandler('storage.unmountDisks');
    if (!reg) throw new Error('storage.unmountDisks not registered');
    await reg.handler({}, CTX);
  } catch (error) {
    console.error(`  (soft) storage.unmountDisks: ${getErrorMessage(error)}`);
  }

  console.error('\n>>> teardown: LVM');
  await softRun('vgchange', ['-an']);
  await softRun('sh', ['-c', 'vgs --noheadings -o vg_name 2>/dev/null | xargs -r -n1 vgremove -ff']);
  await softRun('sh', ['-c', 'pvs --noheadings -o pv_name 2>/dev/null | xargs -r -n1 pvremove -ff']);

  console.error('\n>>> teardown: MD arrays');
  await softRun('sh', ['-c', 'cat /proc/mdstat | grep -oE "^md[0-9]+" | xargs -r -I{} mdadm --stop /dev/{}']);
  await softRun('sh', ['-c', 'cat /proc/mdstat | grep -oE "^md[0-9]+" | xargs -r -I{} mdadm --remove /dev/{}']);

  console.error('\n>>> teardown: per-disk wipe');
  for (const disk of disks) {
    console.error(`   wiping ${disk}`);
    await softRun('wipefs', ['-af', disk]);
    await softRun('sgdisk', ['-Z', disk]);
    await softRun('dd', ['if=/dev/zero', `of=${disk}`, 'bs=1M', 'count=10', 'conv=notrunc,fsync']);
  }

  for (const disk of disks) {
    await softRun('partprobe', [disk]);
  }
  await softRun('udevadm', ['settle']);

  await softRun('rm', ['-f', '/tmp/fstab', '/tmp/crypttab', '/tmp/storage-config.yaml']);

  console.error('full wipe complete\n');
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  const onlyStep = process.argv[3] ?? 'all';
  if (!payloadPath) {
    console.error('usage: provision-harness.js <payload.json> [step]');
    process.exit(2);
  }
  const payload: Payload = PayloadSchema.parse(JSON.parse(await readFile(payloadPath, 'utf-8')));

  if (onlyStep === 'full-wipe') {
    const disks = payload.storage.full_wipe_disks ?? [];
    if (disks.length === 0) {
      throw new Error('full-wipe requires payload.storage.full_wipe_disks (at least one /dev path)');
    }
    await fullWipe(disks);
    return;
  }

  const runAll = onlyStep === 'all';

  if (runAll || onlyStep === 'wipe' || onlyStep === 'prepare') {
    console.error('\n==== PHASE 1: storage prep ====');

    if (runAll || onlyStep === 'wipe') {
      await dispatch('storage.wipeDisks', {
        disk_layouts: payload.storage.disk_layouts,
        environment: 'development',
        job_id: 'provision',
      });
    }

    if (runAll || onlyStep === 'prepare') {
      const PrepareStorageResult = z.object({
        architecture: z.string(),
        uefi: z.boolean(),
        fstab: z.string(),
        crypttab: z.string(),
        preserved_encrypted_volumes: z.array(z.unknown()),
        resolved_layouts: z.array(z.unknown()),
      });
      const storageResult = PrepareStorageResult.parse(
        await dispatch('storage.prepareStorage', {
          disk_layouts: payload.storage.disk_layouts,
          target_path: payload.storage.target_path,
          curtin_yaml: payload.storage.deploy_curtin_yaml,
        }),
      );
      payload.deploy.fstab = cleanFstab(storageResult.fstab);
      console.error(
        `  prepareStorage.fstab preview (cleaned):\n${payload.deploy.fstab
          .split('\n')
          .slice(0, 10)
          .map((l) => '    ' + l)
          .join('\n')}`,
      );
    }
  }

  if (runAll || onlyStep === 'restore') {
    console.error('\n==== PHASE 2: base OS restore ====');
    const image = payload.deploy.image;
    await dispatch('deploy.restoreHttpsLayer', {
      target_path: payload.deploy.target_path,
      url: image.url,
      compression: image.compression,
      sha256: image.sha256,
    });
    await dispatch('deploy.removeWhiteouts', { target_path: payload.deploy.target_path });
  }

  if (runAll || onlyStep === 'chroot' || onlyStep === 'configure') {
    console.error('\n==== PHASE 3: chroot + configure ====');

    if (runAll || onlyStep === 'chroot') {
      await dispatch('deploy.mountChroot', { target_path: payload.deploy.target_path });
    }

    if (runAll || onlyStep === 'configure') {
      await dispatch('deploy.configureMdadm', {
        target_path: payload.deploy.target_path,
        hostname: payload.deploy.hostname,
      });
      await dispatch('deploy.writeFstab', {
        target_path: payload.deploy.target_path,
        content: payload.deploy.fstab,
      });
      if (payload.deploy.crypttab) {
        await dispatch('deploy.writeCrypttab', {
          target_path: payload.deploy.target_path,
          content: payload.deploy.crypttab,
        });
      }
      await dispatch('deploy.installGrub', {
        target_path: payload.deploy.target_path,
        arch: payload.deploy.arch,
        uefi: payload.deploy.uefi,
        distro: payload.deploy.distro,
        grub_disks: payload.deploy.grub_disks,
        config: payload.deploy.grub,
      });
      await dispatch('deploy.finalizeEfi', {
        target_path: payload.deploy.target_path,
        uefi: payload.deploy.uefi,
      });
      await dispatch('deploy.writeCloudInitFiles', {
        target_path: payload.deploy.target_path,
        cloud_cfg: payload.deploy.cloud_init.cloud_cfg,
        meta_data: payload.deploy.cloud_init.meta_data,
        user_data: payload.deploy.cloud_init.user_data,
        network_config: payload.deploy.cloud_init.network_config,
        device_id: payload.deploy.cloud_init.device_id,
        phone_home_creds: payload.deploy.cloud_init.phone_home_creds,
        extra_files: payload.deploy.cloud_init.extra_files,
      });
      if (payload.deploy.roce_iommu) {
        await dispatch('deploy.applyRoceChrootConfig', {
          target_path: payload.deploy.target_path,
        });
      }
    }
  }

  console.error('\n==== STOP ====');
  console.error('Chroot is STILL MOUNTED at ' + payload.deploy.target_path);
  console.error('  Inspect: ls ' + payload.deploy.target_path + '/{etc,boot,usr,var}');
  console.error('  fstab:   cat ' + payload.deploy.target_path + '/etc/fstab');
  console.error('  grub:    cat ' + payload.deploy.target_path + '/etc/default/grub');
  console.error('');
  console.error('To clean up later: node provision-harness.js <payload> teardown');

  if (onlyStep === 'teardown') {
    await dispatch('deploy.unmountChroot', { target_path: payload.deploy.target_path });
    console.error('chroot unmounted; /target fs still mounted. To unmount: umount /target/boot/efi && umount /target');
  }
}

main().catch((error) => {
  console.error('harness failed:', error);
  process.exit(1);
});
