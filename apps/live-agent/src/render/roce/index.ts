import hydraAcsDisableService from './assets/hydra-acs-disable.service';
import hydraRoceEcmpService from './assets/hydra-roce-ecmp.service';
import hydraRoceEcmpScript from './assets/hydra-roce-ecmp.sh';
import hydraRoceQosService from './assets/hydra-roce-qos.service';

import type { DeployRoceVars } from '../../gen/brokkr/agent/v1/operations/deploy_pb';

export const HYDRA_ACS_DISABLE_SERVICE = hydraAcsDisableService;
export const HYDRA_ROCE_ECMP_SERVICE = hydraRoceEcmpService;
export const HYDRA_ROCE_ECMP_SH = hydraRoceEcmpScript;
export const HYDRA_ROCE_QOS_SERVICE = hydraRoceQosService;

export const DOCA_APT_PIN = `Package: mft*
Pin: origin linux.mellanox.com
Pin-Priority: 1001

Package: doca-*
Pin: origin linux.mellanox.com
Pin-Priority: 1001
`;

export interface CloudInitWriteFile {
  path: string;
  content: string;
  permissions: string;
}

export interface RoceUserDataExtras {
  writeFiles: CloudInitWriteFile[];
  runcmd: string[];
}

export function renderRoceUserDataExtras(input: {
  roce: Pick<DeployRoceVars, 'enabled' | 'docaRepoUrl'>;
}): RoceUserDataExtras {
  if (!input.roce.enabled) {
    return { writeFiles: [], runcmd: [] };
  }

  const writeFiles: CloudInitWriteFile[] = [
    { path: '/etc/apt/preferences.d/doca-pin', content: DOCA_APT_PIN, permissions: '0644' },
    { path: '/etc/systemd/system/hydra-roce-qos.service', content: HYDRA_ROCE_QOS_SERVICE, permissions: '0644' },
    {
      path: '/etc/systemd/system/hydra-acs-disable.service',
      content: HYDRA_ACS_DISABLE_SERVICE,
      permissions: '0644',
    },
    { path: '/etc/systemd/system/hydra-roce-ecmp.service', content: HYDRA_ROCE_ECMP_SERVICE, permissions: '0644' },
    { path: '/usr/local/sbin/hydra-roce-ecmp.sh', content: HYDRA_ROCE_ECMP_SH, permissions: '0755' },
  ];

  const runcmd: string[] = [
    'curl -fsSL https://linux.mellanox.com/public/repo/doca/GPG-KEY-Mellanox.pub | gpg --dearmor -o /etc/apt/trusted.gpg.d/GPG-KEY-Mellanox.pub',
    `echo "deb [signed-by=/etc/apt/trusted.gpg.d/GPG-KEY-Mellanox.pub] ${input.roce.docaRepoUrl} ./" > /etc/apt/sources.list.d/doca.list`,
    'apt-get update -y',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y mft kernel-mft-dkms dkms linux-headers-$(uname -r) mlnx-tools pciutils',
    'systemctl daemon-reload && systemctl enable --now hydra-roce-qos.service hydra-acs-disable.service hydra-roce-ecmp.service',
  ];

  return { writeFiles, runcmd };
}
