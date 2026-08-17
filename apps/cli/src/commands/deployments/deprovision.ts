import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { getDeployment } from '../../core/deployments/deployments.js';
import { deprovisionDeployment } from '../../core/deployments/mutations.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveDeploymentId } from './select-deployment.js';

export function registerDeprovisionCommand(parent: Command): void {
  parent
    .command('deployments:deprovision')
    .description('Permanently deprovision a deployment (irreversible)')
    .argument('[id]', 'Deployment ID')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
This action is irreversible. The device will be released back to the supplier
and all data will be lost. The deployment must not be locked.

Examples:
  brokkr deployments:deprovision                          Interactive mode
  brokkr deployments:deprovision <id>                     Prompts for confirmation
  brokkr deployments:deprovision <id> --force             Skip confirmation
  brokkr deployments:deprovision <id> --force --json      Scripted mode`,
    )
    .action(async (idArg: string | undefined, flags: { force: boolean; json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      const id = await resolveDeploymentId(client, idArg);

      const deployment = await withSpinner('Fetching deployment...', () => getDeployment(client, id));

      if (deployment.isLocked) {
        fail(`Deployment "${deployment.name}" is locked. Unlock it first with: brokkr deployments:lock ${id}`);
      }

      if (!flags.force) {
        p.intro(chalk.bold('Deprovision Deployment'));
        p.log.warn(
          `This will permanently deprovision ${chalk.bold(deployment.name)}.\n` +
            `All data will be lost and the device will be released.\n` +
            `This action cannot be undone.`,
        );

        const confirmed = prompt(await p.confirm({ message: 'Are you sure you want to deprovision this deployment?' }));
        if (!confirmed) {
          p.cancel('Cancelled');
          process.exit(0);
        }
      }

      const result = await withSpinner('Deprovisioning deployment...', () => deprovisionDeployment(client, id));

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok('Deployment deprovisioned');
    });
}
