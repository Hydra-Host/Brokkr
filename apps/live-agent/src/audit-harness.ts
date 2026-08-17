import { getHandler, type HandlerContext } from './dispatch/registry';
import { getErrorMessage } from './errors';
import { registerDeployOperations } from './operations/deploy/index';

registerDeployOperations();

interface Case {
  name: string;
  op: string;
  input: unknown;
}

const CASES: Case[] = [
  {
    name: 'mountChroot:/mnt/harness-target',
    op: 'deploy.mountChroot',
    input: { target_path: '/mnt/harness-target' },
  },
  {
    name: 'unmountChroot:/mnt/harness-target',
    op: 'deploy.unmountChroot',
    input: { target_path: '/mnt/harness-target' },
  },

  {
    name: 'removeWhiteouts:/mnt/harness-whiteout',
    op: 'deploy.removeWhiteouts',
    input: { target_path: '/mnt/harness-whiteout' },
  },

  {
    name: 'configureMdadm:/mnt/harness-mdadm',
    op: 'deploy.configureMdadm',
    input: { target_path: '/mnt/harness-mdadm', hostname: 'audit-host' },
  },

  {
    name: 'writeFstab',
    op: 'deploy.writeFstab',
    input: { target_path: '/mnt/harness-files', content: 'UUID=aaa / ext4 defaults 0 1\n' },
  },
  {
    name: 'writeCrypttab',
    op: 'deploy.writeCrypttab',
    input: { target_path: '/mnt/harness-files', content: 'crypt-data UUID=bbb none luks\n' },
  },
  {
    name: 'writeCrypttab:empty (should no-op)',
    op: 'deploy.writeCrypttab',
    input: { target_path: '/mnt/harness-files-empty', content: '' },
  },
  {
    name: 'installLuksScripts',
    op: 'deploy.installLuksScripts',
    input: {
      target_path: '/mnt/harness-files',
      encrypted_volumes: [
        { device: '/dev/md0', mapper: 'crypt-data', mountpoint: '/mnt/data', fs_type: 'xfs', label: 'DATA' },
      ],
      already_keyed: false,
    },
  },
  {
    name: 'writeCloudInitFiles',
    op: 'deploy.writeCloudInitFiles',
    input: {
      target_path: '/mnt/harness-files',
      cloud_cfg: '# cloud.cfg\n',
      meta_data: 'instance-id: 42\n',
      user_data: '#cloud-config\nhostname: h\n',
      network_config: 'version: 2\n',
      device_id: 'harness-device',
      phone_home_creds: { endpoint: 'https://hub.example/phone-home', deployment_os_token: 'harness-token' },
    },
  },

  {
    name: 'applyRoceChrootConfig:scratch-no-unit',
    op: 'deploy.applyRoceChrootConfig',
    input: { target_path: '/mnt/harness-roce-missing' },
  },

  {
    name: 'powerCycleCleanup:/mnt/harness-target',
    op: 'deploy.powerCycleCleanup',
    input: { target_path: '/mnt/harness-target' },
  },
];

async function runOne(name: string, op: string, input: unknown): Promise<void> {
  const reg = getHandler(op);
  if (!reg) {
    console.info(JSON.stringify({ case: name, op, status: 'NOT_REGISTERED' }));
    return;
  }
  const ctx: HandlerContext = {
    work_id: 'audit',
    job_id: 'audit',
    signal: new AbortController().signal,
    resultDelivered: Promise.resolve(),
    reportProgress: () => {},
    emit: async () => {},
  };
  try {
    const result = await reg.handler(input, ctx);
    console.info(JSON.stringify({ case: name, op, status: 'OK', result }));
  } catch (error) {
    console.info(JSON.stringify({ case: name, op, status: 'THREW', error: getErrorMessage(error) }));
  }
}

async function main(): Promise<void> {
  const only = process.argv[2];
  for (const c of CASES) {
    if (only && !c.name.startsWith(only)) continue;
    await runOne(c.name, c.op, c.input);
  }
}

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exit(1);
});
