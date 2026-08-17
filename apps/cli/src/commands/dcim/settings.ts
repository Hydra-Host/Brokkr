import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { updateServerSettings } from '../../core/dcim/mutations.js';
import { getServer } from '../../core/dcim/servers.js';
import { info, ok, parseToggle } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveServerId } from './select-server.js';

export function registerSettingsCommand(parent: Command): void {
  parent
    .command('servers:settings')
    .description('Update server settings (nickname, eco mode)')
    .argument('[id]', 'Device ID')
    .option('--nickname <name>', 'Server nickname')
    .option('--eco-mode <value>', 'Eco mode: on or off')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Update internal server information viewable only by members of your organization.

Eco Mode: When enabled, machines with unrented status (Inventory) will be
automatically powered off to save energy.

Examples:
  brokkr dcim servers:settings                                       Interactive mode
  brokkr dcim servers:settings <id> --nickname "my-gpu-server"       Set nickname
  brokkr dcim servers:settings <id> --eco-mode on                    Enable eco mode
  brokkr dcim servers:settings <id> --nickname "srv" --eco-mode off  Set both
  brokkr dcim servers:settings <id> --nickname "srv" --json          JSON output`,
    )
    .action(async (idArg: string | undefined, flags: { nickname?: string; ecoMode?: string; json: boolean }) => {
      const client = getAuthenticatedClient();
      const id = await resolveServerId(client, idArg);

      const server = await withSpinner('Fetching server...', () => getServer(client, id));

      let nickname = flags.nickname;
      let ecoMode: boolean | undefined;

      if (flags.ecoMode !== undefined) {
        ecoMode = parseToggle(flags.ecoMode, '--eco-mode');
      }

      const needsPrompts = nickname === undefined && ecoMode === undefined;

      if (needsPrompts) {
        p.intro(chalk.bold('Server Settings'));

        info('Server', server.displayName);
        info('Current Eco Mode', server.ecoMode ? 'On' : 'Off');

        nickname = prompt(
          await p.text({
            message: 'Nickname',
            initialValue: server.displayName,
            placeholder: 'Enter nickname',
          }),
        );

        const ecoModeValue = prompt(
          await p.select({
            message: 'Eco Mode',
            options: [
              { value: 'on' as const, label: 'On', hint: 'Power off unrented machines to save energy' },
              { value: 'off' as const, label: 'Off', hint: 'Keep machines powered on' },
            ],
            initialValue: server.ecoMode ? 'on' : 'off',
          }),
        );
        ecoMode = ecoModeValue === 'on';
      }

      const body: { nickname?: string; ecoMode?: boolean } = {};
      if (nickname !== undefined) body.nickname = nickname;
      if (ecoMode !== undefined) body.ecoMode = ecoMode;

      const result = await withSpinner('Updating server settings...', () => updateServerSettings(client, id, body));

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok('Server settings updated');
    });
}
