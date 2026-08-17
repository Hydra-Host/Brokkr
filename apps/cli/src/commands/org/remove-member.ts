import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { listMembers, removeMember } from '../../core/org/members.js';
import { requireManagePermission } from '../../core/permissions.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerRemoveMemberCommand(parent: Command): void {
  parent
    .command('remove-member')
    .description('Remove a member from the organization')
    .argument('[id]', 'Membership ID to remove')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr org remove-member                         Interactive: pick from members
  brokkr org remove-member <id>                    One-shot: remove by ID
  brokkr org remove-member <id> --json             One-shot with JSON output`,
    )
    .action(async (idArg: string | undefined, flags: { json: boolean }) => {
      requireManagePermission();
      const client = getAuthenticatedClient();
      let membershipId = idArg;

      if (!membershipId) {
        const members = await withSpinner('Fetching members...', async () => {
          const result = await listMembers(client, { page: 1, pageSize: 100 });
          return result.data;
        });

        if (members.length === 0) {
          fail('No members found');
        }

        p.intro(chalk.bold('Remove Member'));

        membershipId = prompt(
          await p.select({
            message: 'Select member to remove',
            options: members.map((m) => ({
              value: m.id,
              label: `${m.name ?? m.email}`,
              hint: `${m.role} · ${m.email}`,
            })),
          }),
        );

        const confirmed = prompt(
          await p.confirm({
            message: 'Are you sure you want to remove this member?',
          }),
        );

        if (!confirmed) {
          p.cancel('Cancelled');
          process.exit(0);
        }
      }

      const member = await withSpinner('Removing member...', async () => {
        return removeMember(client, membershipId!);
      });

      if (flags.json) {
        renderJson(member);
        return;
      }

      ok(`Removed ${chalk.bold(member.name ?? member.email)} from the organization`);
    });
}
