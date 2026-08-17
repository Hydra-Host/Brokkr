import type { OperationInput, OperationName, OperationOutput } from '@repo/bridge-agent-protocol';
import { mkdir } from 'node:fs/promises';

import { callHandler } from '../../dispatch/call-handler';
import { registerOperation } from '../../dispatch/registry';
import { assertTargetPathSafe } from '../deploy/targetPath';

export function registerPrepareStorage(): void {
  registerOperation('storage.prepareStorage', async ({ disk_layouts, target_path, curtin_yaml }, ctx) => {
    assertTargetPathSafe(target_path);
    const call = <N extends OperationName>(op: N, input: OperationInput<N>): Promise<OperationOutput<N>> =>
      callHandler(op, input, ctx);

    const arch = await call('system.getArchitecture', {});

    await call('storage.unmountDisks', {});

    const resolved = await call('storage.resolveDisks', { disk_layouts });

    const uefi = await call('storage.detectUefiMode', {});

    const apply = await call('storage.applyStorageLayout', { curtin_yaml, target_path });
    if (!apply.success) {
      throw new Error(`curtin apply failed: ${apply.error ?? 'unknown'}`);
    }

    let fstab = apply.fstab_content.replace(/\s+$/, '') + '\n';
    let crypttab = '';
    const preserved_encrypted_volumes: {
      device: string;
      mapper: string;
      mountpoint: string;
      fs_type: string;
      label: string;
      luks_uuid: string;
    }[] = [];

    // Preserved mappers use `pcrypt-N` so they never collide with curtin's `crypt-N` (also 0-based) — a shared namespace could map two LUKS containers to one /dev/mapper node.
    let cryptCounter = 0;
    const claimed_md_devices: string[] = [];

    for (const layout of resolved.layouts) {
      if (layout.wipe) continue;
      const mountpoint = layout.mountpoint ?? '';
      if (!mountpoint) continue;

      const diskName = layout.disks[0];
      if (!diskName) continue;

      try {
        await mkdir(`${target_path}${mountpoint}`, { recursive: true });
      } catch (err: unknown) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
        if (code !== 'EEXIST') throw err;
      }

      const probe = await call('storage.detectPreservedDiskInfo', {
        disk_name: diskName,
        claimed_md_devices,
      });

      if (probe.leaf_device) claimed_md_devices.push(probe.leaf_device);

      if (probe.detected_luks && probe.luks_uuid) {
        const dm_name = `pcrypt-${cryptCounter++}`;
        const luksNoDash = probe.luks_uuid.replace(/-/g, '');
        const fsFormat = layout.fs_type ?? 'ext4';
        fstab +=
          `# ${mountpoint} was on /dev/mapper/${dm_name} during curtin installation (preserved)\n` +
          `/dev/disk/by-id/dm-uuid-CRYPT-LUKS2-${luksNoDash}-${dm_name} ` +
          `${mountpoint} ${fsFormat} nofail,defaults 0 2\n`;
        crypttab += `${dm_name} UUID=${probe.luks_uuid} none luks,noauto,nofail\n`;
        preserved_encrypted_volumes.push({
          device: probe.leaf_device,
          mapper: dm_name,
          mountpoint,
          fs_type: fsFormat,
          label: mountpoint.replace(/^\/+|\/+$/g, '').replaceAll('/', '-') || 'data',
          luks_uuid: probe.luks_uuid,
        });
      } else if (probe.fs_uuid) {
        const fsType = probe.fs_type || 'ext4';
        fstab +=
          `# ${mountpoint} preserved disk\n` + `UUID=${probe.fs_uuid} ${mountpoint} ${fsType} nofail,defaults 0 2\n`;
      }
    }

    return {
      architecture: arch.arch,
      uefi: uefi.uefi_mode,
      fstab,
      crypttab,
      preserved_encrypted_volumes,
      resolved_layouts: resolved.layouts,
    };
  });
}
