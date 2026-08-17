import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { VALID_RESCUE_ACTIONS, type RescueAction } from '../../core/constants.js';
import { getDeployment } from '../../core/deployments/deployments.js';
import { activateRescueMode, deactivateRescueMode } from '../../core/deployments/mutations.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveDeploymentId } from './select-deployment.js';

export function registerRescueCommand(parent: Command): void {
  parent
    .command('deployments:rescue')
    .description('Activate or deactivate rescue mode')
    .argument('[id]', 'Deployment ID')
    .option('--action <action>', 'Rescue action: activate or deactivate')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Actions:
  activate    Boot into temporary rescue OS for diagnostics
  deactivate  Exit rescue mode and reboot to primary OS

Examples:
  brokkr deployments:rescue                                    Interactive mode
  brokkr deployments:rescue <id> --action activate             Enter rescue mode
  brokkr deployments:rescue <id> --action deactivate --json    Exit rescue mode`,
    )
    .action(async (idArg: string | undefined, flags: { action?: string; json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      const id = await resolveDeploymentId(client, idArg);

      let action = flags.action as RescueAction | undefined;

      if (action && !VALID_RESCUE_ACTIONS.includes(action)) {
        fail(`Invalid action "${action}". Must be one of: ${VALID_RESCUE_ACTIONS.join(', ')}`);
      }

      if (!action) {
        const deployment = await withSpinner('Fetching deployment...', () => getDeployment(client, id));
        const inRescue = deployment.rescueOs !== null;

        p.intro(chalk.bold('Rescue Mode'));
        action = prompt(
          await p.select({
            message: 'Action',
            options: [
              {
                value: 'activate' as const,
                label: 'Activate Rescue Mode',
                hint: inRescue ? 'Already active' : 'Boot into rescue OS',
              },
              {
                value: 'deactivate' as const,
                label: 'Deactivate Rescue Mode',
                hint: inRescue ? 'Reboot to primary OS' : 'Not in rescue mode',
              },
            ],
          }),
        );
      }

      const result = await withSpinner(
        action === 'activate' ? 'Activating rescue mode...' : 'Deactivating rescue mode...',
        () => (action === 'activate' ? activateRescueMode(client, id) : deactivateRescueMode(client, id)),
      );

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(action === 'activate' ? 'Rescue mode activated' : 'Rescue mode deactivated');
    });
}
