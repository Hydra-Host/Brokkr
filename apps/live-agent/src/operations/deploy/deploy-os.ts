import type { OperationInput, OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import { callHandler } from '../../dispatch/call-handler';
import { registerOperation } from '../../dispatch/registry';
import { renderCloudInitBundle } from '../../render/cloudinit';
import { renderFallbackGrub, renderGrubDefaults } from '../../render/grub';
import { assertTargetPathSafe } from './target-path';

type Architecture = 'amd64' | 'arm64';

interface ImageSource {
  url: string;
  compression: 'gzip' | 'zstd';
  sha256: string;
}

interface Customizations {
  layers: Array<{
    name: string;
    url: string;
    compression: 'gzip' | 'zstd';
    stack_position: number;
    sha256: string;
  }>;
}

interface EncryptedVolumeConfig {
  device: string;
  mapper: string;
  mountpoint: string;
  fs_type: string;
  label: string;
}

interface PhoneHomeCredsInput {
  deployment_os_token: string;
  endpoint: string;
}

interface CloudInitVarsInput {
  device_id: string;
  ssh_pubkeys: string[];
  password_hash?: string | undefined;
  netplan_yaml: string;
  phone_home_creds: PhoneHomeCredsInput;
  custom_user_data_yaml?: string | undefined;
}

interface GrubVarsInput {
  gpu_model?: string | undefined;
  pci_realloc_off: boolean;
  serial_ports?: { port: string; baud?: number | undefined } | undefined;
  purge_ttys: boolean;
}

interface RoceVarsInput {
  enabled: boolean;
  doca_repo_url: string;
}

interface InfinibandVarsInput {
  enabled: boolean;
  node_desc: string;
}

interface DeployOsInput {
  target_path: string;
  arch: Architecture;
  uefi: boolean;
  distro: string;
  hostname: string;
  grub_disks: string[];
  image: ImageSource;
  customizations?: Customizations | undefined;
  fstab: string;
  crypttab?: string | undefined;
  encrypted_volumes: EncryptedVolumeConfig[];
  rekey_volumes: EncryptedVolumeConfig[];
  roce_iommu: boolean;
  cloud_init_vars: CloudInitVarsInput;
  grub_vars: GrubVarsInput;
  luks_already_keyed: boolean;
  roce: RoceVarsInput;
  infiniband?: InfinibandVarsInput | undefined;
}

export function registerDeployOS(): void {
  registerOperation('deploy.deployOS', async (input, ctx) => {
    const i: DeployOsInput = input;
    assertTargetPathSafe(i.target_path);

    const call = <N extends OperationName>(op: N, subInput: OperationInput<N>): Promise<OperationOutput<N>> =>
      callHandler(op, subInput, ctx);

    const progress = (fraction: number, message: string): void => {
      ctx.reportProgress(fraction, message);
    };

    const cloudInitFiles = renderCloudInitBundle({
      hostname: i.hostname,
      distro: i.distro,
      cloudInit: {
        deviceId: i.cloud_init_vars.device_id,
        sshPubkeys: i.cloud_init_vars.ssh_pubkeys,
        passwordHash: i.cloud_init_vars.password_hash,
        netplanYaml: i.cloud_init_vars.netplan_yaml,
        customUserDataYaml: i.cloud_init_vars.custom_user_data_yaml,
        phoneHomeCreds: {
          deployment_os_token: i.cloud_init_vars.phone_home_creds.deployment_os_token,
          endpoint: i.cloud_init_vars.phone_home_creds.endpoint,
        },
      },
      roce: { enabled: i.roce.enabled, docaRepoUrl: i.roce.doca_repo_url },
      infiniband: i.infiniband ? { enabled: i.infiniband.enabled, nodeDesc: i.infiniband.node_desc } : undefined,
    });

    const grubDefaults = renderGrubDefaults({
      grub: {
        gpuModel: i.grub_vars.gpu_model,
        pciReallocOff: i.grub_vars.pci_realloc_off,
        serialPorts: i.grub_vars.serial_ports
          ? { port: i.grub_vars.serial_ports.port, baud: i.grub_vars.serial_ports.baud }
          : undefined,
      },
      roceIommu: i.roce_iommu,
    });

    const fallbackCfg = i.uefi ? renderFallbackGrub({ distro: i.distro, arch: i.arch }) : undefined;

    // LUKS scripts are rendered inside installLuksScripts from agent templates (script-injection hardening).
    const hasLuks = i.encrypted_volumes.length > 0;

    progress(0.05, 'restoring base image');
    await call('deploy.restoreHttpsLayer', {
      target_path: i.target_path,
      url: i.image.url,
      compression: i.image.compression,
      sha256: i.image.sha256,
    });

    if (i.customizations) {
      progress(0.15, 'applying customization layers');
      const layers = [...i.customizations.layers].sort(
        (a, b) => a.stack_position - b.stack_position || a.name.localeCompare(b.name),
      );
      for (const layer of layers) {
        await call('deploy.restoreHttpsLayer', {
          target_path: i.target_path,
          url: layer.url,
          compression: layer.compression,
          sha256: layer.sha256,
        });
      }
    }

    progress(0.25, 'removing overlay whiteouts');
    await call('deploy.removeWhiteouts', { target_path: i.target_path });

    progress(0.3, 'mounting chroot');
    await call('deploy.mountChroot', { target_path: i.target_path });

    try {
      progress(0.35, 'configuring mdadm');
      await call('deploy.configureMdadm', {
        target_path: i.target_path,
        hostname: i.hostname,
      });

      progress(0.4, 'writing fstab');
      await call('deploy.writeFstab', {
        target_path: i.target_path,
        content: i.fstab,
      });

      if (i.crypttab !== undefined && i.crypttab.length > 0) {
        progress(0.45, 'writing crypttab');
        await call('deploy.writeCrypttab', {
          target_path: i.target_path,
          content: i.crypttab,
        });
      }

      if (hasLuks) {
        progress(0.5, 'installing LUKS scripts');
        await call('deploy.installLuksScripts', {
          target_path: i.target_path,
          encrypted_volumes: i.encrypted_volumes,
          rekey_volumes: i.rekey_volumes,
          already_keyed: i.luks_already_keyed,
        });
      }

      progress(0.6, 'installing GRUB');
      await call('deploy.installGrub', {
        target_path: i.target_path,
        arch: i.arch,
        uefi: i.uefi,
        distro: i.distro,
        grub_disks: i.grub_disks,
        grub_defaults: grubDefaults,
        ...(fallbackCfg !== undefined && { grub_fallback_cfg: fallbackCfg }),
        purge_ttys: i.grub_vars.purge_ttys,
      });

      progress(0.75, 'finalizing EFI');
      await call('deploy.finalizeEfi', {
        target_path: i.target_path,
        uefi: i.uefi,
      });

      progress(0.85, 'writing cloud-init files');
      const REQUIRED_PATHS = new Set([
        'etc/cloud/cloud.cfg',
        'var/lib/cloud/seed/nocloud/meta-data',
        'var/lib/cloud/seed/nocloud/user-data',
        'var/lib/cloud/seed/nocloud/network-config',
        'var/lib/cloud/scripts/per-boot/90-phone-home.sh',
        'var/lib/brokkr/phone-home-creds.json',
      ]);
      const byPath = Object.fromEntries(cloudInitFiles.map((f) => [f.path, f.content]));
      const required = (p: string): string => {
        const content = byPath[p];
        if (content === undefined) throw new Error(`cloud-init bundle missing required file: ${p}`);
        return content;
      };
      const extraFiles = cloudInitFiles.filter((f) => !REQUIRED_PATHS.has(f.path));
      // Phone-home script/creds bodies never cross the protocol — the writer renders them agent-side.
      await call('deploy.writeCloudInitFiles', {
        target_path: i.target_path,
        cloud_cfg: required('etc/cloud/cloud.cfg'),
        meta_data: required('var/lib/cloud/seed/nocloud/meta-data'),
        user_data: required('var/lib/cloud/seed/nocloud/user-data'),
        network_config: required('var/lib/cloud/seed/nocloud/network-config'),
        device_id: i.cloud_init_vars.device_id,
        phone_home_creds: {
          deployment_os_token: i.cloud_init_vars.phone_home_creds.deployment_os_token,
          endpoint: i.cloud_init_vars.phone_home_creds.endpoint,
        },
        extra_files: extraFiles,
      });

      if (i.roce_iommu) {
        progress(0.9, 'applying RoCE chroot config');
        await call('deploy.applyRoceChrootConfig', { target_path: i.target_path });
      }
    } finally {
      progress(0.92, 'unmounting chroot');
      await call('deploy.unmountChroot', { target_path: i.target_path });
    }

    progress(0.97, 'power-cycle cleanup');
    await call('deploy.powerCycleCleanup', { target_path: i.target_path });

    progress(1.0, 'deploy complete');

    return { deployed: true as const };
  });
}
