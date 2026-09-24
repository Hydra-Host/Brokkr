import * as p from '@clack/prompts';
import { ContractType, SELECTABLE_CONTRACT_TYPES, newContractTypeRejectionMessage } from '@repo/utils';
import chalk from 'chalk';
import { Command, Option } from 'commander';
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
  warn,
} from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveInventoryItemId } from './select-inventory-item.js';

/** Resolve --contract-type / deprecated --interruptible for inventory:rent. Exported for tests. */
export function resolveInventoryRentContractType(flags: { contractType?: string; interruptible?: boolean }): {
  contractType?: string;
  warning?: string;
  rejection?: string;
} {
  let contractType = flags.contractType;
  let warning: string | undefined;

  if (flags.interruptible) {
    warning =
      '--interruptible is deprecated and maps to RESERVED_ROLLING until commerce billing is ready. Use --contract-type=RESERVED_ROLLING.';
    contractType = contractType ?? ContractType.RESERVED_ROLLING;
  }

  if (contractType) {
    const rejection = newContractTypeRejectionMessage(contractType);
    if (rejection) return { contractType, warning, rejection };
  } else if (SELECTABLE_CONTRACT_TYPES.length === 1) {
    contractType = SELECTABLE_CONTRACT_TYPES[0];
  }

  return { contractType, warning };
}

export function inventoryRentConfirmationLabel(contractType: string): string {
  return contractType === ContractType.RESERVED_ROLLING ? 'Reserved Rolling' : contractType;
}

export function registerInventoryRentCommand(program: Command): void {
  program
    .command('inventory:rent')
    .description('Rent a server from the marketplace')
    .argument('[id]', 'Device ID to rent')
    .option('--name <name>', 'Deployment name')
    .option('--os <slug>', 'Operating system slug (e.g. ubuntu-plucky-vanilla)')
    .option('--ssh-keys <ids>', 'Comma-separated SSH key IDs')
    .option('--contract-type <type>', 'Contract type (only RESERVED_ROLLING until commerce billing is ready)')
    .addOption(
      new Option(
        '--interruptible',
        'Deprecated: Interruptible rentals are unavailable until commerce billing is ready. Use --contract-type=RESERVED_ROLLING.',
      ).hideHelp(),
    )
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
  Only Reserved Rolling is accepted until commerce billing can price other terms.

Examples:
  brokkr inventory:rent                                              Interactive mode (pick server + configure)
  brokkr inventory:rent <id>                                        Interactive mode for a specific server
  brokkr inventory:rent <id> --name "my-server" --os ubuntu-plucky-vanilla --ssh-keys "uuid1,uuid2" --contract-type RESERVED_ROLLING --force
  brokkr inventory:rent <id> --name "srv" --os ubuntu-plucky-vanilla --ssh-keys "uuid" --contract-type RESERVED_ROLLING --project-id "proj-uuid" --force --json`,
    )
    .action(
      async (
        idArg: string | undefined,
        flags: {
          name?: string;
          os?: string;
          sshKeys?: string;
          contractType?: string;
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

        const resolved = resolveInventoryRentContractType(flags);
        if (resolved.warning) warn(resolved.warning);
        if (resolved.rejection) fail(resolved.rejection);
        let contractType = resolved.contractType;

        let projectId: string | undefined = flags.projectId;

        const needsPrompts = !deploymentName || !operatingSystem || !sshKeyIds || !contractType;

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

        if (!contractType) {
          contractType = prompt(
            await p.select({
              message: 'Contract type',
              options: [
                // Only Reserved Rolling until commerce billing can price the other terms.
                // { value: 'ON_DEMAND', label: 'On Demand', hint: 'Billed hourly, cancel any time' },
                { value: 'RESERVED_ROLLING', label: 'Reserved Rolling', hint: 'Reserved with rolling renewal' },
                // { value: 'INTERRUPTIBLE', label: 'Interruptible', hint: 'Lower price, may be interrupted' },
                // { value: 'RESERVED', label: 'Reserved', hint: 'Fixed-term reservation' },
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
          const priceCents = item.pricing.onDemandPerHourCents;
          const priceLabel = priceCents != null ? `${centsToDollars(priceCents)}/hr` : '—';

          if (needsPrompts) {
            p.log.warn(
              `This will rent ${chalk.bold(item.name)} at ${chalk.bold(priceLabel)} (${inventoryRentConfirmationLabel(contractType || ContractType.RESERVED_ROLLING)}).\n` +
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
