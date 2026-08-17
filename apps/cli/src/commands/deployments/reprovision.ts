import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { getDeployment, type DiskLayout } from '../../core/deployments/deployments.js';
import { listOrganizationSshKeys, reprovisionDeployment } from '../../core/deployments/mutations.js';
import { DiskLayoutSchema } from '../../core/deployments/schemas.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok, parseCsvFlag, parseCustomizationsFlag, validateSsrfSafeHttpsUrl } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveDeploymentId } from './select-deployment.js';

export function registerReprovisionCommand(parent: Command): void {
  parent
    .command('deployments:reprovision')
    .description('Wipe and reinstall the OS on a deployment')
    .argument('[id]', 'Deployment ID')
    .option('--name <name>', 'Deployment name after reprovision')
    .option('--os <slug>', 'Operating system slug (e.g. ubuntu-noble-vanilla)')
    .option('--ssh-keys <ids>', 'Comma-separated SSH key IDs')
    .option('--disk-layout <json>', 'Disk layout configuration as JSON array')
    .option('--cloud-init <config>', 'Cloud-init configuration (YAML string)')
    .option('--ipxe-url <url>', 'Custom iPXE script URL')
    .option(
      '--customizations <json>',
      'Layer customizations as JSON (e.g. \'{"gpuDriver":"nvidia-driver-580","miscSoftware":["docker"]}\')',
    )
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
The deployment must not be locked. In interactive mode, default disk layouts
from the deployment are used. Use --disk-layout to override.

Examples:
  brokkr deployments:reprovision                           Interactive mode
  brokkr deployments:reprovision <id> --name "my-server" --os ubuntu-noble-vanilla --ssh-keys "key1-uuid,key2-uuid" --force
  brokkr deployments:reprovision <id> --name "srv" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --force --json`,
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
          customizations?: string;
          force: boolean;
          json: boolean;
        },
      ) => {
        requireManagePermission();
        const client = getAuthenticatedClient();
        const id = await resolveDeploymentId(client, idArg);

        const deployment = await withSpinner('Fetching deployment...', () => getDeployment(client, id));

        if (deployment.isLocked) {
          fail(`Deployment "${deployment.name}" is locked. Unlock it first with: brokkr deployments:lock ${id}`);
        }

        let deploymentName = flags.name;
        let operatingSystem = flags.os
          ? deployment.availableBaseLayers.find((l) => l.slug === flags.os)?.slug
          : undefined;
        if (flags.os && !operatingSystem) {
          fail(`Unknown OS "${flags.os}". Available: ${deployment.availableBaseLayers.map((l) => l.slug).join(', ')}`);
        }
        let sshKeyIds = parseCsvFlag(flags.sshKeys, '--ssh-keys must contain at least one SSH key ID');

        const needsPrompts = !deploymentName || !operatingSystem || !sshKeyIds;

        if (needsPrompts) {
          p.intro(chalk.bold('Reprovision Deployment'));
        }

        if (!deploymentName) {
          deploymentName = prompt(
            await p.text({
              message: 'Deployment name',
              initialValue: deployment.name,
              validate: (v) => {
                if (!v.trim()) return 'Name is required';
              },
            }),
          );
        }

        if (!operatingSystem) {
          if (deployment.availableBaseLayers.length === 0) {
            fail('No operating systems available for this deployment');
          }
          const selected = prompt(
            await p.select({
              message: 'Operating system',
              options: deployment.availableBaseLayers.map((l) => ({
                value: l.slug,
                label: l.name,
              })),
            }),
          );
          operatingSystem = deployment.availableBaseLayers.find((l) => l.slug === selected)?.slug;
          if (!operatingSystem) {
            fail(`Unknown OS "${selected}"`);
          }
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
          diskLayouts = deployment.defaultDiskLayouts.map((dl) => ({ ...dl, wipe: true }));
        }

        const customizations = parseCustomizationsFlag(flags.customizations);

        if (flags.ipxeUrl) {
          validateSsrfSafeHttpsUrl(flags.ipxeUrl, 'iPXE URL');
        }

        if (!flags.force) {
          if (needsPrompts) {
            p.log.warn(
              `This will wipe ${chalk.bold(deployment.name)} and reinstall with ${chalk.bold(operatingSystem)}.\n` +
                `All data on the device will be lost.`,
            );
          }

          const confirmed = prompt(await p.confirm({ message: 'Proceed with reprovision?' }));
          if (!confirmed) {
            p.cancel('Cancelled');
            process.exit(0);
          }
        }

        const result = await withSpinner('Reprovisioning deployment...', () =>
          reprovisionDeployment(client, id, {
            deploymentName: deploymentName!,
            operatingSystem: operatingSystem!,
            sshKeyIds: sshKeyIds!,
            diskLayouts,
            cloudInit: flags.cloudInit,
            ipxeUrl: flags.ipxeUrl,
            customizations,
          }),
        );

        if (flags.json) {
          renderJson(result);
          return;
        }

        ok('Reprovision initiated');
      },
    );
}
