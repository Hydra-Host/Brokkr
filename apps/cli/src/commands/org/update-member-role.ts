import * as p from '@clack/prompts';
import { OrganizationMembershipRoleSchema } from '@repo/api-client';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { listMembers, updateMemberRole } from '../../core/org/members.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

const VALID_ROLES = OrganizationMembershipRoleSchema.options;

export function registerUpdateMemberRoleCommand(parent: Command): void {
  parent
    .command('update-member-role')
    .description("Update a member's role in the organization")
    .argument('[id]', 'Membership ID')
    .option('--role <role>', 'New role (Admin, Member, Owner)')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Roles:
  Member       Can view resources and use the platform
  Admin        Can manage members, invitations, and org settings
  Owner        Full access including billing and destructive actions

Examples:
  brokkr org update-member-role                              Interactive mode
  brokkr org update-member-role <id> --role Admin            One-shot mode
  brokkr org update-member-role <id> --role Admin --json`,
    )
    .action(async (idArg: string | undefined, flags: { role?: string; json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      let memberId = idArg;
      let role = flags.role;

      if (role && !VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
        fail(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(', ')}`);
      }

      if (!memberId) {
        const members = await withSpinner('Fetching members...', async () => {
          const result = await listMembers(client, { page: 1, pageSize: 100 });
          return result.data;
        });

        if (members.length === 0) {
          fail('No members found');
        }

        p.intro(chalk.bold('Update Member Role'));

        memberId = prompt(
          await p.select({
            message: 'Select member',
            options: members.map((m) => ({
              value: m.id,
              label: `${m.name ?? m.email}`,
              hint: `${m.role} · ${m.email}`,
            })),
          }),
        );
      }

      if (!role) {
        role = prompt(
          await p.select({
            message: 'New role',
            options: VALID_ROLES.map((r) => ({ value: r, label: r })),
          }),
        );
      }

      const member = await withSpinner('Updating role...', async () => {
        return updateMemberRole(client, memberId!, role!);
      });

      if (flags.json) {
        renderJson(member);
        return;
      }

      ok(`Updated ${chalk.bold(member.name ?? member.email)} to ${chalk.bold(role!)}`);
    });
}
