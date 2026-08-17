import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import { invitationDetailFields, invitationListColumns } from '../../core/org/columns.js';
import { getInvitation, listInvitations, type InvitationListItem } from '../../core/org/invitations.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function InvitationsListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listInvitations(client, query),
  );

  if (loading) return <Loading message="Fetching invitations..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<InvitationListItem>
      columns={invitationListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'org-invitation-detail', params: { id: row.id }, title: row.email })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function InvitationDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: invitation, loading, error } = useAsync(() => getInvitation(client, id), [id]);

  if (loading) return <Loading message="Loading invitation..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!invitation) return <ErrorView message="Invitation not found" onBack={pop} />;

  return (
    <DetailView
      title={`Invitation to ${invitation.email}`}
      subtitle={invitation.id}
      fields={invitationDetailFields(invitation)}
      onBack={pop}
    />
  );
}
