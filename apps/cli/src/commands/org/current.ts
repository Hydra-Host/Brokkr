import chalk from 'chalk';
import { Command } from 'commander';
import { getConnectionMode, initConfigIfNeeded } from '../../config/env.js';
import { getActiveOrg } from '../../config/store.js';
import { dim, fail, formatTenantType } from '../../ui/format.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerOrgCurrentCommand(parent: Command): void {
  parent
    .command('current')
    .description('Show the active organization')
    .option('--json', 'Output as JSON', false)
    .action(async (flags: { json: boolean }) => {
      initConfigIfNeeded();

      if (getConnectionMode() === 'bridge') {
        const { getSession: fetchSession } = await import('../../core/auth.js');
        const session = await withSpinner('Checking session...', () => fetchSession());
        if (session.activeOrganizationId) {
          if (flags.json) {
            renderJson({ id: session.activeOrganizationId, mode: 'bridge' });
            return;
          }
          console.log(`\n  Organization: ${chalk.bold(session.activeOrganizationId)} ${dim('(bridge)')}\n`);
        } else {
          fail(`No organization selected. Run: ${chalk.bold('brokkr org select')}`);
        }
        return;
      }

      const current = getActiveOrg();
      if (!current) {
        fail(`No organization selected. Run: ${chalk.bold('brokkr org select')}`);
      }

      if (flags.json) {
        renderJson({
          id: current.id,
          name: current.name,
          tenantType: current.tenantType,
          role: current.role ?? null,
        });
        return;
      }

      const roleLabel = current.role ? ` · ${current.role}` : '';
      console.log(`\n  ${chalk.bold(current.name)} ${dim(`[${formatTenantType(current.tenantType)}${roleLabel}]`)}\n`);
    });
}
