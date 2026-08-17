import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { provisionServer, type DiskLayout } from '../../core/dcim/mutations.js';
import { getServer } from '../../core/dcim/servers.js';
import { listOrganizationSshKeys } from '../../core/deployments/mutations.js';
import { DiskLayoutSchema } from '../../core/deployments/schemas.js';
import { fail, ok, parseCsvFlag, parseCustomizationsFlag, validateSsrfSafeHttpsUrl } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveServerId } from './select-server.js';

export function registerProvisionCommand(parent: Command): void {
  parent
    .command('servers:provision')
    .description('Provision a baremetal server (install OS, deploy SSH keys)')
    .argument('[id]', 'Device ID')
    .option('--name <name>', 'Deployment name')
    .option('--os <slug>', 'Operating system slug (e.g. ubuntu-noble-vanilla)')
    .option('--ssh-keys <ids>', 'Comma-separated SSH key IDs')
    .option('--disk-layout <json>', 'Disk layout configuration as JSON array')
    .option('--cloud-init <config>', 'Cloud-init configuration (YAML string)')
    .option('--ipxe-url <url>', 'Custom iPXE script URL')
    .option('--project-id <id>', 'Project ID to assign the deployment to')
    .option('--interruptible', 'Provision as an interruptible instance (may be interrupted with notice)')
    .option(
      '--customizations <json>',
      'Layer customizations as JSON (e.g. \'{"gpuDriver":"nvidia-driver-580","miscSoftware":["docker"]}\')',
    )
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Initiates the provisioning workflow for a server, including OS installation,
network configuration, and SSH key deployment. In interactive mode, default
disk layouts from the server are used. Use --disk-layout to override.

Examples:
  brokkr dcim servers:provision                                Interactive mode
  brokkr dcim servers:provision <id> --name "my-server" --os ubuntu-noble-vanilla --ssh-keys "key1-uuid,key2-uuid" --force
  brokkr dcim servers:provision <id> --name "srv" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --force --json`,
    )
    .action(
      async (
        idArg: string | undefined,
        flags: {
          name?: string;
          os?: string;
          sshKeys?: string;
          diskLayout?: string;
          cloudInit?: string;
          ipxeUrl?: string;
          projectId?: string;
          interruptible?: boolean;
          customizations?: string;
          force: boolean;
          json: boolean;
        },
      ) => {
        const client = getAuthenticatedClient();
        const id = await resolveServerId(client, idArg);

        const server = await withSpinner('Fetching server...', () => getServer(client, id));

        let deploymentName = flags.name;
        let operatingSystem = flags.os ? server.availableBaseLayers.find((l) => l.slug === flags.os)?.slug : undefined;
        if (flags.os && !operatingSystem) {
          fail(`Unknown OS "${flags.os}". Available: ${server.availableBaseLayers.map((l) => l.slug).join(', ')}`);
        }
        let sshKeyIds = parseCsvFlag(flags.sshKeys, '--ssh-keys must contain at least one SSH key ID');

        const needsPrompts = !deploymentName || !operatingSystem || !sshKeyIds;

        if (needsPrompts) {
          p.intro(chalk.bold('Provision Server'));
        }

        if (!deploymentName) {
          deploymentName = prompt(
            await p.text({
              message: 'Deployment name',
              validate: (v) => {
                if (!v.trim()) return 'Name is required';
              },
            }),
          );
        }

        if (!operatingSystem) {
          if (server.availableBaseLayers.length === 0) {
            fail('No operating systems available for this server');
          }
          operatingSystem = prompt(
            await p.select({
              message: 'Operating system',
              options: server.availableBaseLayers.map((l) => ({
                value: l.slug,
                label: l.name,
              })),
            }),
          );
        }

        if (!sshKeyIds) {
          const keys = await withSpinner('Fetching SSH keys...', () => listOrganizationSshKeys(client));
          if (keys.length === 0) {
            fail('No SSH keys found. Add one first at /account/ssh-keys/create');
          }
          sshKeyIds = prompt(
            await p.multiselect({
              message: 'SSH keys',
              options: keys.map((k) => ({
                value: k.id,
                label: k.name,
                hint: `${k.userName} · ${k.fingerprint.slice(0, 20)}`,
              })),
              required: true,
            }),
          );
        }

        let diskLayouts: DiskLayout[];
        if (flags.diskLayout) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(flags.diskLayout);
          } catch {
            fail('Invalid --disk-layout JSON. Must be a JSON array of disk layout objects.');
          }
          const validated = DiskLayoutSchema.safeParse(parsed);
          if (!validated.success) {
            fail(`Invalid --disk-layout: ${validated.error.issues.map((i) => i.message).join(', ')}`);
          }
          diskLayouts = validated.data;
        } else {
          diskLayouts = server.defaultDiskLayouts.map((dl) => ({ ...dl, wipe: true }));
        }

        const customizations = parseCustomizationsFlag(flags.customizations);

        if (flags.ipxeUrl) {
          validateSsrfSafeHttpsUrl(flags.ipxeUrl, 'iPXE URL');
        }

        if (!flags.force) {
          if (needsPrompts) {
            p.log.warn(
              `This will provision ${chalk.bold(server.displayName)} with ${chalk.bold(operatingSystem)}.\n` +
                `The server will be configured and OS will be installed.`,
            );
          }

          const confirmed = prompt(await p.confirm({ message: 'Proceed with provisioning?' }));
          if (!confirmed) {
            p.cancel('Cancelled');
            process.exit(0);
          }
        }

        const result = await withSpinner('Provisioning server...', () =>
          provisionServer(client, id, {
            deploymentName: deploymentName!,
            operatingSystem: operatingSystem!,
            sshKeyIds: sshKeyIds!,
            diskLayouts,
            cloudInit: flags.cloudInit,
            ipxeUrl: flags.ipxeUrl,
            projectId: flags.projectId,
            isInterruptible: flags.interruptible ?? false,
            customizations,
          }),
        );

        if (flags.json) {
          renderJson(result);
          return;
        }

        ok('Provision initiated');
      },
    );
}
