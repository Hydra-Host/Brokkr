import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerCreateProjectCommand(parent: Command): void {
  parent
    .command('deployments:create-project')
    .description('Create a deployment project')
    .option('--name <name>', 'Project name')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr deployments:create-project                          Interactive mode
  brokkr deployments:create-project --name "Production"      One-shot mode
  brokkr deployments:create-project --name "Staging" --json`,
    )
    .action(async (flags: { name?: string; json: boolean }) => {
      const client = getAuthenticatedClient();

      let name = flags.name;
      if (!name) {
        p.intro(chalk.bold('Create Project'));
        name = prompt(
          await p.text({
            message: 'Project name',
            validate: (v) => {
              if (!v.trim()) return 'Name is required';
            },
          }),
        );
      }

      const result = await withSpinner('Creating project...', async () => {
        const res = await client.createDeploymentProject({ body: { name: name! } });
        if (res.status !== 201) throw new Error(`Failed to create project (${res.status})`);
        return { id: res.body.id, name: res.body.name };
      });

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(`Project "${chalk.bold(result.name)}" created (${result.id})`);
    });
}
