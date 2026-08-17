import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { getOrgSettings, updateOrgSettings } from '../../core/org/settings.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerUpdateSettingsCommand(parent: Command): void {
  parent
    .command('update-settings')
    .description('Update organization settings')
    .option('--name <name>', 'Organization name')
    .option('--email <email>', 'Contact email (use "" to clear)')
    .option('--country <country>', 'Country (use "" to clear)')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
In one-shot mode, only provided flags are changed.

Examples:
  brokkr org update-settings                                         Interactive mode
  brokkr org update-settings --name "My Org"                         Update name only
  brokkr org update-settings --email support@example.com             Update email only
  brokkr org update-settings --name "My Org" --email "" --json       Update name, clear email`,
    )
    .action(async (flags: { name?: string; email?: string; country?: string; json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();

      const hasFlags = flags.name !== undefined || flags.email !== undefined || flags.country !== undefined;

      if (!hasFlags) {
        const current = await withSpinner('Fetching settings...', async () => {
          return getOrgSettings(client);
        });

        p.intro(chalk.bold('Update Organization Settings'));

        const name = prompt(
          await p.text({
            message: 'Organization name',
            initialValue: current.name,
            validate: (v) => {
              if (!v || v.trim().length === 0) return 'Name is required';
              if (v.length > 100) return 'Name must be 100 characters or less';
            },
          }),
        );

        const email = prompt(
          await p.text({
            message: 'Contact email (leave empty to clear)',
            initialValue: current.email ?? '',
          }),
        );

        const country = prompt(
          await p.text({
            message: 'Country (leave empty to clear)',
            initialValue: current.country ?? '',
          }),
        );

        const result = await withSpinner('Updating settings...', async () => {
          return updateOrgSettings(client, {
            name,
            email: email || null,
            country: country || null,
          });
        });

        if (flags.json) {
          renderJson(result);
          return;
        }

        ok('Organization settings updated');
        return;
      }

      if (flags.name !== undefined && flags.name.trim().length === 0) {
        fail('Organization name cannot be empty');
      }

      const result = await withSpinner('Updating settings...', async () => {
        return updateOrgSettings(client, {
          ...(flags.name !== undefined ? { name: flags.name } : {}),
          ...(flags.email !== undefined ? { email: flags.email || null } : {}),
          ...(flags.country !== undefined ? { country: flags.country || null } : {}),
        });
      });

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok('Organization settings updated');
    });
}
