import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import { invitationDetailFields, invitationListColumns } from '../../core/org/columns.js';
import { getInvitation, listInvitations } from '../../core/org/invitations.js';
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

export function registerInvitationsCommand(parent: Command): void {
  searchOption(
    sortOption(
      paginationOptions(
        parent
          .command('invitations')
          .description('List organization invitations, or show one by ID')
          .argument('[id]', 'Invitation ID to show details for'),
      ),
    ),
  )
    .addHelpText(
      'after',
      `
Sortable fields (--sort "field:asc|desc,..."):
  email, role, status, createdAt, expiresAt
  Default sort: createdAt:desc

Searchable fields (--search matches any of):
  email

Examples:
  brokkr org invitations --json                           List all invitations as JSON
  brokkr org invitations --sort status:asc --json         Sort by status
  brokkr org invitations --sort expiresAt:asc --json      Sort by expiration
  brokkr org invitations --search "alice@" --json         Search by email
  brokkr org invitations <id> --json                      Get invitation details`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showInvitation(id, flags.json);
      } else {
        await listInvitationsAction(flags);
      }
    });
}

async function listInvitationsAction(flags: PaginationFlags): Promise<void> {
  const result = await withSpinner('Fetching invitations...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((query) => listInvitations(client, query), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Invitations"
      columns={invitationListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr org invitations')}
    />,
  );
}

async function showInvitation(invitationId: string, json: boolean): Promise<void> {
  const invitation = await withSpinner(`Fetching invitation ${invitationId}...`, async () => {
    const client = getAuthenticatedClient();
    return getInvitation(client, invitationId);
  });

  if (json) {
    renderJson(invitation);
    return;
  }

  renderOnce(
    <DetailContent
      title={`Invitation to ${invitation.email}`}
      subtitle={invitation.id}
      fields={invitationDetailFields(invitation)}
    />,
  );
}
