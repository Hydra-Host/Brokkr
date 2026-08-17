import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { getDeployment } from '../../core/deployments/deployments.js';
import { toggleDeploymentLock } from '../../core/deployments/mutations.js';
import { requireManagePermission } from '../../core/permissions.js';
import { info, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveDeploymentId } from './select-deployment.js';

export function registerLockCommand(parent: Command): void {
  parent
    .command('deployments:lock')
    .description('Toggle deployment lock (prevents destructive actions when locked)')
    .argument('[id]', 'Deployment ID')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr deployments:lock                                  Interactive mode
  brokkr deployments:lock <id>                             Toggle lock state
  brokkr deployments:lock <id> --json                      Toggle with JSON output`,
    )
    .action(async (idArg: string | undefined, flags: { json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      const id = await resolveDeploymentId(client, idArg);

      const deployment = await withSpinner('Fetching deployment...', () => getDeployment(client, id));
      const isLocked = deployment.isLocked;

      if (!flags.json && !idArg) {
        info('Current state', isLocked ? 'Locked' : 'Unlocked');
      }

      if (!idArg) {
        const action = isLocked ? 'Unlock' : 'Lock';
        const confirmed = prompt(await p.confirm({ message: `${action} deployment ${chalk.bold(deployment.name)}?` }));
        if (!confirmed) {
          p.cancel('Cancelled');
          process.exit(0);
        }
      }

      const result = await withSpinner(isLocked ? 'Unlocking deployment...' : 'Locking deployment...', () =>
        toggleDeploymentLock(client, id),
      );

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(`Deployment is now ${isLocked ? 'unlocked' : 'locked'}`);
    });
}
