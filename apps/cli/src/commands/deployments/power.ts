import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { VALID_POWER_ACTIONS, type PowerAction } from '../../core/constants.js';
import { powerControlDeployment, powerCycleDeployment } from '../../core/deployments/mutations.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveDeploymentId } from './select-deployment.js';

export function registerPowerCommand(parent: Command): void {
  parent
    .command('deployments:power')
    .description('Power on, off, or cycle a deployment')
    .argument('[id]', 'Deployment ID')
    .option('--action <action>', 'Power action: on, off, or cycle')
    .option('--force', 'Skip confirmation for power cycle', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Actions:
  on     Power on the device via IPMI
  off    Power off the device via IPMI
  cycle  Hard power cycle (equivalent to unplug + replug)

Examples:
  brokkr deployments:power                                 Interactive mode
  brokkr deployments:power <id> --action on                One-shot: power on
  brokkr deployments:power <id> --action cycle --force     Power cycle without confirmation
  brokkr deployments:power <id> --action cycle --json      Power cycle with JSON`,
    )
    .action(async (idArg: string | undefined, flags: { action?: string; force: boolean; json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      const id = await resolveDeploymentId(client, idArg);

      let action = flags.action as PowerAction | undefined;

      if (action && !VALID_POWER_ACTIONS.includes(action)) {
        fail(`Invalid action "${action}". Must be one of: ${VALID_POWER_ACTIONS.join(', ')}`);
      }

      if (!action) {
        p.intro(chalk.bold('Power Control'));
        action = prompt(
          await p.select({
            message: 'Action',
            options: [
              { value: 'on' as const, label: 'Power On', hint: 'Turn on via IPMI' },
              { value: 'off' as const, label: 'Power Off', hint: 'Shut down via IPMI' },
              { value: 'cycle' as const, label: 'Power Cycle', hint: 'Hard restart (like unplugging)' },
            ],
          }),
        );
      }

      if (action === 'cycle' && !flags.force) {
        const confirmed = prompt(
          await p.confirm({
            message: 'Power cycle will hard-restart the device. All running processes will be killed. Continue?',
          }),
        );
        if (!confirmed) {
          p.cancel('Cancelled');
          process.exit(0);
        }
      }

      const result = await withSpinner(`Power ${action}...`, async () => {
        if (action === 'cycle') {
          return powerCycleDeployment(client, id);
        }
        return powerControlDeployment(client, id, action!);
      });

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(`Power ${action} initiated`);
    });
}
