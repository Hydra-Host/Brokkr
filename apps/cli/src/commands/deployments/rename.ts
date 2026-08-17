import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { renameDeployment } from '../../core/deployments/mutations.js';
import { requireManagePermission } from '../../core/permissions.js';
import { ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveDeploymentId } from './select-deployment.js';

export function registerRenameCommand(parent: Command): void {
  parent
    .command('deployments:rename')
    .description('Rename a deployment')
    .argument('[id]', 'Deployment ID')
    .option('--name <name>', 'New name for the deployment')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr deployments:rename                                Interactive mode
  brokkr deployments:rename <id> --name "my-server"        One-shot mode
  brokkr deployments:rename <id> --name "my-server" --json`,
    )
    .action(async (idArg: string | undefined, flags: { name?: string; json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      const id = await resolveDeploymentId(client, idArg);

      let name = flags.name;
      if (!name) {
        p.intro(chalk.bold('Rename Deployment'));
        name = prompt(
          await p.text({
            message: 'New name',
            validate: (v) => {
              if (!v.trim()) return 'Name is required';
            },
          }),
        );
      }

      const result = await withSpinner('Renaming deployment...', () => renameDeployment(client, id, name!));

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(`Deployment renamed to ${chalk.bold(result.name)}`);
    });
}
