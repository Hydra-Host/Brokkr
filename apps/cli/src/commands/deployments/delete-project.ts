import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerDeleteProjectCommand(parent: Command): void {
  parent
    .command('deployments:delete-project')
    .description('Delete a deployment project')
    .argument('[id]', 'Project ID')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
The project must not be the default project and must have no deployments.
Move all deployments to another project first.

Examples:
  brokkr deployments:delete-project                          Interactive mode
  brokkr deployments:delete-project <id> --force             Skip confirmation
  brokkr deployments:delete-project <id> --force --json      Scripted mode`,
    )
    .action(async (idArg: string | undefined, flags: { force: boolean; json: boolean }) => {
      const client = getAuthenticatedClient();

      let projectId = idArg;

      if (!projectId) {
        const projects = await withSpinner('Fetching projects...', async () => {
          const result = await client.getDeploymentProjects({ query: { page: 1, pageSize: 100 } });
          if (result.status !== 200) throw new Error(`Failed to list projects (${result.status})`);
          return result.body.data;
        });

        const deletable = projects.filter((proj) => !proj.isDefault);
        if (deletable.length === 0) {
          fail('No deletable projects found (the default project cannot be deleted)');
        }

        p.intro(chalk.bold('Delete Project'));
        projectId = prompt(
          await p.select({
            message: 'Select project to delete',
            options: deletable.map((proj) => ({
              value: proj.id,
              label: proj.name,
              hint: `${proj.deployments.length} deployments`,
            })),
          }),
        );
      }

      if (!flags.force) {
        const confirmed = prompt(await p.confirm({ message: 'Are you sure you want to delete this project?' }));
        if (!confirmed) {
          p.cancel('Cancelled');
          process.exit(0);
        }
      }

      const result = await withSpinner('Deleting project...', async () => {
        const res = await client.deleteDeploymentProject({ params: { projectId: projectId! } });
        if (res.status === 404) throw new Error(`Project not found: ${projectId}`);
        if (res.status !== 200) throw new Error(`Failed to delete project (${res.status})`);
        return { id: res.body.id, name: res.body.name };
      });

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(`Project "${result.name}" deleted`);
    });
}
