import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import { memberDetailFields, memberListColumns } from '../../core/org/columns.js';
import { getMember, listMembers } from '../../core/org/members.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { StaticTable } from '../../tui/components/static-table.js';
import { renderOnce } from '../../tui/render-once.js';
import {
  fetchPage,
  paginationFooter,
  paginationOptions,
  renderJson,
  searchOption,
  sortOption,
  withSpinner,
  type PaginationFlags,
} from '../../ui/table.js';

export function registerMembersCommand(parent: Command): void {
  searchOption(
    sortOption(
      paginationOptions(
        parent
          .command('members')
          .description('List organization members, or show one by ID')
          .argument('[id]', 'Member ID to show details for'),
      ),
    ),
  )
    .option('--role <role>', 'Legacy filter by role (Owner, Admin, Member)')
    .addHelpText(
      'after',
      `
Sortable fields (--sort "field:asc|desc,..."):
  role, name, email, createdAt
  Default sort: role:asc, name:asc

Searchable fields (--search matches any of):
  user.name, user.email

Legacy filter flag:
  --role <role>   Exact-match filter (Owner, Admin, Member).

Examples:
  brokkr org members --json                          List all members as JSON
  brokkr org members --role Admin --json             Filter by role (exact match)
  brokkr org members --sort email:asc --json         Sort by email
  brokkr org members --search "alice@" --json        Search by name or email
  brokkr org members <id> --json                     Get member details`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags & { role?: string }, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showMember(id, flags.json);
      } else {
        await listMembersAction(flags);
      }
    });
}

async function listMembersAction(flags: PaginationFlags & { role?: string }): Promise<void> {
  const result = await withSpinner('Fetching members...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((query) => listMembers(client, { ...query, ...(flags.role ? { role: flags.role } : {}) }), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Members"
      columns={memberListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr org members')}
    />,
  );
}

async function showMember(memberId: string, json: boolean): Promise<void> {
  const member = await withSpinner(`Fetching member ${memberId}...`, async () => {
    const client = getAuthenticatedClient();
    return getMember(client, memberId);
  });

  if (json) {
    renderJson(member);
    return;
  }

  renderOnce(
    <DetailContent title={`Member ${member.role}`} subtitle={member.id} fields={memberDetailFields(member)} />,
  );
}
