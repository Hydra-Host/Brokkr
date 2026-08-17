import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { listDeploymentProjects } from '../../core/deployments/deployments.js';
import { listOrganizationSshKeys } from '../../core/deployments/mutations.js';
import { DiskLayoutSchema } from '../../core/deployments/schemas.js';
import { getInventoryItem, rentInventoryDevice, type InventoryDiskLayout } from '../../core/inventory/inventory.js';
import {
  centsToDollars,
  fail,
  ok,
  parseCsvFlag,
  parseCustomizationsFlag,
  validateSsrfSafeHttpsUrl,
} from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveInventoryItemId } from './select-inventory-item.js';

export function registerInventoryRentCommand(program: Command): void {
  program
    .command('inventory:rent')
    .description('Rent a server from the marketplace')
    .argument('[id]', 'Device ID to rent')
    .option('--name <name>', 'Deployment name')
    .option('--os <slug>', 'Operating system slug (e.g. ubuntu-plucky-vanilla)')
    .option('--ssh-keys <ids>', 'Comma-separated SSH key IDs')
    .option('--interruptible', 'Rent as an interruptible instance (lower price, may be interrupted with notice)')
    .option('--project-id <id>', 'Project ID to assign the deployment to')
    .option('--disk-layout <json>', 'Disk layout configuration as JSON array (uses device default if omitted)')
    .option('--cloud-init <config>', 'Cloud-init configuration (YAML string)')
    .option('--ipxe-url <url>', 'Custom iPXE script URL (must use HTTPS)')
    .option(
      '--customizations <json>',
      'Layer customizations as JSON (e.g. \'{"gpuDriver":"nvidia-driver-580","miscSoftware":["docker"]}\')',
    )
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output result as JSON', false)
    .addHelpText(
      'after',
      `
Rents an available server from the marketplace. In interactive mode, prompts
for any values not provided. Disk layout defaults to the device's recommended
layout unless overridden with --disk-layout.

Billing:
  Default (no flag)   On demand — billed hourly, cancel any time
  --interruptible     Lower price, may be interrupted with notice

Examples:
  brokkr inventory:rent                                              Interactive mode (pick server + configure)
  brokkr inventory:rent <id>                                        Interactive mode for a specific server
  brokkr inventory:rent <id> --name "my-server" --os ubuntu-plucky-vanilla --ssh-keys "uuid1,uuid2" --force
  brokkr inventory:rent <id> --name "srv" --os ubuntu-plucky-vanilla --ssh-keys "uuid" --interruptible --project-id "proj-uuid" --force --json`,
    )
    .action(
      async (
        idArg: string | undefined,
        flags: {
          name?: string;
          os?: string;
          sshKeys?: string;
          interruptible?: boolean;
          projectId?: string;
          diskLayout?: string;
          cloudInit?: string;
          ipxeUrl?: string;
          customizations?: string;
          force: boolean;
          json: boolean;
        },
      ) => {
        const client = getAuthenticatedClient();
        const id = await resolveInventoryItemId(client, idArg);

        const item = await withSpinner('Fetching server details...', () => getInventoryItem(client, id));

        let deploymentName = flags.name;
        let operatingSystem = flags.os ? item.availableBaseLayers.find((l) => l.slug === flags.os)?.slug : undefined;
        if (flags.os && !operatingSystem) {
          fail(`Unknown OS "${flags.os}". Available: ${item.availableBaseLayers.map((l) => l.slug).join(', ')}`);
        }
        let sshKeyIds = parseCsvFlag(flags.sshKeys, '--ssh-keys must contain at least one SSH key ID');

        let isInterruptible: boolean | undefined;
        if (item.isInterruptibleOnly) {
          isInterruptible = true;
        } else if (flags.interruptible !== undefined) {
          isInterruptible = flags.interruptible;
        }

        let projectId: string | undefined = flags.projectId;

        const needsPrompts = !deploymentName || !operatingSystem || !sshKeyIds || isInterruptible === undefined;

        if (needsPrompts) {
          p.intro(chalk.bold('Rent Server'));
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
          if (item.availableBaseLayers.length === 0) {
            fail('No operating systems available for this server');
          }
          operatingSystem = prompt(
            await p.select({
              message: 'Operating system',
              options: item.availableBaseLayers.map((l) => ({
                value: l.slug,
                label: l.name,
              })),
            }),
          );
        }

        if (!sshKeyIds) {
          const keys = await withSpinner('Fetching SSH keys...', () => listOrganizationSshKeys(client));
          if (keys.length === 0) {
            fail('No SSH keys found. Add one at the organization SSH keys page.');
          }
          sshKeyIds = prompt(
            await p.multiselect({
              message: 'SSH keys to deploy',
              options: keys.map((k) => ({
                value: k.id,
                label: k.name,
                hint: `${k.userName} · ${k.fingerprint.slice(0, 20)}`,
              })),
              required: true,
            }),
          );
        }

        if (isInterruptible === undefined) {
          isInterruptible = prompt(
            await p.select({
              message: 'Billing type',
              options: [
                { value: false, label: 'On Demand', hint: 'Billed hourly, cancel any time' },
                { value: true, label: 'Interruptible', hint: 'Lower price, may be interrupted' },
              ],
            }),
          );
        }

        if (!projectId) {
          const projects = await withSpinner('Fetching projects...', () =>
            listDeploymentProjects(client, { page: 1, pageSize: 100 }),
          );
          if (projects.data.length > 0) {
            projectId =
              prompt(
                await p.select({
                  message: 'Assign to project',
                  options: [
                    { value: '', label: 'No project' },
                    ...projects.data.map((proj) => ({
                      value: proj.id,
                      label: proj.name,
                      hint: proj.isDefault ? 'default' : undefined,
                    })),
                  ],
                }),
              ) || undefined;
          }
        }

        let diskLayouts: InventoryDiskLayout[];
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
          diskLayouts = item.defaultDiskLayouts;
        }

        const customizations = parseCustomizationsFlag(flags.customizations);

        if (flags.ipxeUrl) {
          validateSsrfSafeHttpsUrl(flags.ipxeUrl, 'iPXE URL');
        }

        if (!flags.force) {
          const priceCents = isInterruptible
            ? item.pricing.interruptiblePerHourCents
            : item.pricing.onDemandPerHourCents;
          const priceLabel = priceCents != null ? `${centsToDollars(priceCents)}/hr` : '—';
          const billingLabel = isInterruptible ? 'Interruptible' : 'On Demand';

          if (needsPrompts) {
            p.log.warn(
              `This will rent ${chalk.bold(item.name)} at ${chalk.bold(priceLabel)} (${billingLabel}).\n` +
                `OS: ${chalk.bold(operatingSystem)} · SSH keys: ${sshKeyIds.length}`,
            );
          }

          const confirmed = prompt(await p.confirm({ message: 'Proceed with rental?' }));
          if (!confirmed) {
            p.cancel('Cancelled');
            process.exit(0);
          }
        }

        const result = await withSpinner('Renting server...', () =>
          rentInventoryDevice(client, id, {
            isInterruptible: isInterruptible!,
            deploymentName: deploymentName!,
            operatingSystem: operatingSystem!,
            sshKeyIds: sshKeyIds!,
            projectId: projectId || undefined,
            diskLayouts,
            cloudInit: flags.cloudInit ?? null,
            ipxeUrl: flags.ipxeUrl ?? null,
            customizations,
          }),
        );

        if (flags.json) {
          renderJson(result);
          return;
        }

        ok('Server rental initiated — deployment will appear in your deployments list shortly');
      },
    );
}
