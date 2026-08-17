import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { decommissionServer } from '../../core/dcim/mutations.js';
import { getServer } from '../../core/dcim/servers.js';
import { ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveServerId } from './select-server.js';

export function registerDecommissionCommand(parent: Command): void {
  parent
    .command('servers:decommission')
    .description('Decommission a server (removes from active inventory)')
    .argument('[id]', 'Device ID')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Marks a server as decommissioned, removing it from active inventory.
The server record is retained for historical reporting.

Examples:
  brokkr dcim servers:decommission                              Interactive mode
  brokkr dcim servers:decommission <id>                         Prompts for confirmation
  brokkr dcim servers:decommission <id> --force                 Skip confirmation
  brokkr dcim servers:decommission <id> --force --json          Scripted mode`,
    )
    .action(async (idArg: string | undefined, flags: { force: boolean; json: boolean }) => {
      const client = getAuthenticatedClient();
      const id = await resolveServerId(client, idArg);

      if (!flags.force) {
        const server = await withSpinner('Fetching server...', () => getServer(client, id));

        p.intro(chalk.bold('Decommission Server'));
        p.log.warn(
          `This will decommission ${chalk.bold(server.displayName)} and remove it from active inventory.\n` +
            `The server record will be retained for historical reporting.`,
        );

        const confirmed = prompt(await p.confirm({ message: 'Are you sure you want to decommission this server?' }));
        if (!confirmed) {
          p.cancel('Cancelled');
          process.exit(0);
        }
      }

      const result = await withSpinner('Decommissioning server...', () => decommissionServer(client, id));

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok('Server decommissioned');
    });
}
