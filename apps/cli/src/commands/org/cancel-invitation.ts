import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { cancelInvitation, listInvitations } from '../../core/org/invitations.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, formatDate, ok } from '../../ui/format.js';
import { confirmOrExit, prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerCancelInvitationCommand(parent: Command): void {
  parent
    .command('cancel-invitation')
    .description('Cancel a pending invitation')
    .argument('[id]', 'Invitation ID to cancel')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr org cancel-invitation                         Interactive: pick from pending invitations
  brokkr org cancel-invitation <id>                    Prompts for confirmation
  brokkr org cancel-invitation <id> --force            Skip confirmation
  brokkr org cancel-invitation <id> --force --json     Scripted mode`,
    )
    .action(async (idArg: string | undefined, flags: { force: boolean; json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      let invitationId = idArg;
      let inviteEmail: string | null = null;

      if (!invitationId) {
        const pending = await withSpinner('Fetching pending invitations...', async () => {
          const result = await listInvitations(client, { page: 1, pageSize: 100 });
          return result.data.filter((inv) => inv.status === 'pending');
        });

        if (pending.length === 0) {
          fail('No pending invitations to cancel');
        }

        p.intro(chalk.bold('Cancel Invitation'));

        invitationId = prompt(
          await p.select({
            message: 'Select invitation to cancel',
            options: pending.map((inv) => ({
              value: inv.id,
              label: inv.email,
              hint: `${inv.role} · invited ${formatDate(inv.createdAt)}`,
            })),
          }),
        );

        inviteEmail = pending.find((inv) => inv.id === invitationId)?.email ?? null;
      }

      if (!flags.force) {
        const label = inviteEmail ? `to ${inviteEmail}` : invitationId;
        await confirmOrExit(`Cancel invitation ${label}?`);
      }

      const invitation = await withSpinner('Canceling invitation...', async () => {
        return cancelInvitation(client, invitationId!);
      });

      if (flags.json) {
        renderJson(invitation);
        return;
      }

      ok(`Invitation to ${chalk.bold(invitation.email)} canceled`);
    });
}
