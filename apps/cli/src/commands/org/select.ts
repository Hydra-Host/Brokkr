import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getEnvApiKey, getProcessApiKey, initConfigIfNeeded } from '../../config/env.js';
import { getActiveOrg, getSession, isApiKeySession, saveActiveOrg } from '../../config/store.js';
import { listOrganizations, setActiveOrganization } from '../../core/organizations.js';
import { fail, formatTenantType, ok, warn } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerOrgSelectCommand(parent: Command, opts?: { isBridge?: boolean }): void {
  parent
    .command('select', { hidden: opts?.isBridge ?? false })
    .description('Select your active organization')
    .argument('[orgId]', 'Organization ID to switch to')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr org select                       Interactive mode
  brokkr org select <orgId>               One-shot mode
  brokkr org select <orgId> --json`,
    )
    .action(async (orgIdArg: string | undefined, flags: { json: boolean }, cmd: Command) => {
      if (orgIdArg?.startsWith('-')) {
        cmd.help();
      }
      initConfigIfNeeded();

      if (isApiKeySession(getSession()) || getProcessApiKey() || getEnvApiKey()) {
        fail('Organization switching is not available with API key auth. API keys are bound to a single organization.');
      }

      const orgs = await withSpinner('Fetching organizations...', () => listOrganizations());

      if (orgs.length === 0) {
        if (orgIdArg || flags.json) {
          fail('No organizations found.');
        }
        warn('No organizations found.');
        process.exit(0);
      }

      let orgId = orgIdArg;
      if (!orgId) {
        if (flags.json) {
          fail('An organization id argument is required with --json.');
        }
        const currentOrg = getActiveOrg();
        orgId = prompt(
          await p.select({
            message: 'Select an organization',
            options: orgs.map((o) => ({
              value: o.id,
              label: `${o.name}${o.id === currentOrg?.id ? chalk.green(' (current)') : ''}`,
              hint: `${o.role} · ${formatTenantType(o.tenantType)}`,
            })),
          }),
        );
      }

      const matched = orgs.find((o) => o.id === orgId);
      if (!matched) {
        fail(`Organization not found: ${orgId}`);
      }

      await withSpinner('Switching organization...', () => setActiveOrganization(matched.id));
      saveActiveOrg({ id: matched.id, name: matched.name, tenantType: matched.tenantType, role: matched.role });

      if (flags.json) {
        renderJson({ id: matched.id, name: matched.name, tenantType: matched.tenantType, role: matched.role });
        return;
      }

      ok(`Switched to ${chalk.bold(matched.name)}`);
    });
}
