import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { createInvitation, listInvitationRoles } from '../../core/org/invitations.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerInviteCommand(parent: Command): void {
  parent
    .command('invite')
    .description('Invite a member to the organization')
    .argument('[email]', 'Email address to invite')
    .option('--role-id <id>', 'System or custom role ID to assign')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr org invite                                    Interactive mode
  brokkr org invite user@example.com                   Prompts for a role
  brokkr org invite user@example.com --role-id <id>    One-shot mode
  brokkr org invite user@example.com --role-id <id> --json`,
    )
    .action(async (emailArg: string | undefined, flags: { roleId?: string; json: boolean }) => {
      requireManagePermission();
      let email = emailArg;
      let roleId = flags.roleId;
      const client = getAuthenticatedClient();

      if (!email || !roleId) {
        p.intro(chalk.bold('Invite Member'));
      }

      if (!email) {
        email = prompt(
          await p.text({
            message: 'Email address',
            placeholder: 'colleague@example.com',
            validate: (v) => {
              if (!v.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return 'A valid email is required';
            },
          }),
        );
      }

      if (!roleId) {
        const roles = await withSpinner('Fetching organization roles...', () => listInvitationRoles(client));
        if (roles.length === 0) {
          fail('No roles are available for this organization');
        }
        roleId = prompt(
          await p.select({
            message: 'Role',
            options: roles.map((role) => ({
              value: role.id,
              label: role.name,
              hint: role.description ?? (role.isSystem ? 'System role' : 'Custom role'),
            })),
          }),
        );
      }

      if (!email || !roleId) {
        fail('Email and role are required');
      }
      const invitation = await withSpinner(`Sending invitation to ${email}...`, async () => {
        return createInvitation(client, { email, roleId });
      });

      if (flags.json) {
        renderJson(invitation);
        return;
      }

      ok(`Invitation sent to ${chalk.bold(email)} (role: ${chalk.bold(invitation.role)})`);
    });
}
