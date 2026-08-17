import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { EXPIRATION_OPTIONS } from '../../core/constants.js';
import { createApiKey } from '../../core/org/api-keys.js';
import { fail, ok, warn } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

function parseDuration(value: string): number | undefined {
  if (value === 'none') return undefined;
  const match = value.match(/^(\d+)(d|y)$/);
  if (!match) return undefined;
  const num = parseInt(match[1]!, 10);
  const unit = match[2]!;
  if (unit === 'd') return num * 24 * 60 * 60;
  if (unit === 'y') return num * 365 * 24 * 60 * 60;
  return undefined;
}

export function registerCreateApiKeyCommand(parent: Command): void {
  parent
    .command('create-api-key')
    .description('Create a new API key')
    .argument('[name]', 'Name for the API key')
    .option('--expires-in <duration>', 'Expiration: 7d, 30d, 90d, 1y, or none (default: none)')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Expiration durations:
  none    No expiration (default)
  7d      7 days
  30d     30 days
  90d     90 days
  1y      1 year

Examples:
  brokkr org create-api-key                                  Interactive mode
  brokkr org create-api-key "my-key"                         Prompts for expiration
  brokkr org create-api-key "my-key" --expires-in 30d        One-shot mode
  brokkr org create-api-key "my-key" --expires-in none --json`,
    )
    .action(async (nameArg: string | undefined, flags: { expiresIn?: string; json: boolean }) => {
      let name = nameArg;
      let expiresInMilliseconds: number | undefined;

      if (flags.expiresIn) {
        const validValues = EXPIRATION_OPTIONS.map((o) => o.value);
        if (!validValues.includes(flags.expiresIn)) {
          fail(`Invalid --expires-in "${flags.expiresIn}". Must be one of: ${validValues.join(', ')}`);
        }
        const duration = parseDuration(flags.expiresIn);
        expiresInMilliseconds = duration === undefined ? undefined : duration * 1000;
      }

      if (!name || flags.expiresIn === undefined) {
        p.intro(chalk.bold('Create API Key'));
      }

      if (!name) {
        name = prompt(
          await p.text({
            message: 'Key name',
            placeholder: 'my-api-key',
            validate: (v) => {
              if (!v || v.trim().length === 0) return 'Name is required';
              if (v.length > 32) return 'Name must be 32 characters or less';
            },
          }),
        );
      }

      if (flags.expiresIn === undefined) {
        const expChoice = prompt(
          await p.select({
            message: 'Expiration',
            options: EXPIRATION_OPTIONS,
          }),
        );
        const duration = parseDuration(expChoice);
        expiresInMilliseconds = duration === undefined ? undefined : duration * 1000;
      }

      const client = getAuthenticatedClient();
      const result = await withSpinner('Creating API key...', async () => {
        return createApiKey(client, { name: name!, expiresInMilliseconds });
      });

      if (flags.json) {
        console.error(chalk.yellow('  Warning: output contains a secret that will not be shown again'));
        renderJson(result);
        return;
      }

      ok(`API key ${chalk.bold(result.name)} created`);
      console.log();
      warn('Save this key — it will not be shown again:');
      console.log(`  ${chalk.bold(result.key)}`);
    });
}
