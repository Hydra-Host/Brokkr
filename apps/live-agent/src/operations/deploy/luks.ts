import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerOperation } from '../../dispatch/registry';
import { renderLuksLock, renderLuksRekey, renderLuksUnlock, type LuksVolumeRenderInput } from '../../render/luks';
import { assertTargetPathSafe } from './targetPath';

const SCRIPT_DIR = 'usr/local/bin';
const SCRIPT_MODE = 0o755;

// Script-injection hardening: bodies are never accepted from the bridge — the agent renders its own templates from validated params, up front so a template error aborts before any write.
export function registerLuksScriptInstaller(): void {
  registerOperation('deploy.installLuksScripts', async (input) => {
    const { target_path, encrypted_volumes, rekey_volumes, already_keyed } = input;
    assertTargetPathSafe(target_path);

    const toRenderInput = (v: {
      device: string;
      mapper: string;
      mountpoint: string;
      fs_type: string;
      label: string;
      luks_uuid?: string | undefined;
    }): LuksVolumeRenderInput => ({
      device: v.device,
      mapper: v.mapper,
      mountpoint: v.mountpoint,
      fsType: v.fs_type,
      label: v.label,
      luksUuid: v.luks_uuid ?? '',
    });

    const allVolumes: LuksVolumeRenderInput[] = encrypted_volumes.map(toRenderInput);
    const rekeyVolumes: LuksVolumeRenderInput[] = rekey_volumes.map(toRenderInput);

    // rekey must refuse preserved volumes by stored luks_uuid, NOT by isLuks (curtin luksFormats new RAID volumes too), so new RAID volumes can still rekey.
    const preservedLuksUuids = encrypted_volumes
      .map((v) => v.luks_uuid)
      .filter((u): u is string => typeof u === 'string' && u.length > 0);

    const scripts: Array<[string, string]> = [
      [
        'luks-rekey',
        renderLuksRekey({ encryptedVolumes: rekeyVolumes, alreadyKeyed: already_keyed, preservedLuksUuids }),
      ],
      ['luks-unlock', renderLuksUnlock({ encryptedVolumes: allVolumes })],
      ['luks-lock', renderLuksLock({ encryptedVolumes: allVolumes })],
    ];

    const dir = join(target_path, SCRIPT_DIR);
    await mkdir(dir, { recursive: true });

    const installed: string[] = [];
    for (const [name, content] of scripts) {
      const full = join(dir, name);
      const tmp = `${full}.tmp-${process.pid}`;
      await writeFile(tmp, content, { mode: SCRIPT_MODE });
      await rename(tmp, full);
      installed.push(full);
    }

    return { installed };
  });
}
