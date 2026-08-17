import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import { memberDetailFields, memberListColumns } from '../../core/org/columns.js';
import { getMember, listMembers, type MemberListItem } from '../../core/org/members.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function MembersListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listMembers(client, query),
  );

  if (loading) return <Loading message="Fetching members..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<MemberListItem>
      columns={memberListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'org-member-detail', params: { id: row.id }, title: row.name ?? row.email })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function MemberDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: member, loading, error } = useAsync(() => getMember(client, id), [id]);

  if (loading) return <Loading message="Loading member..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!member) return <ErrorView message="Member not found" onBack={pop} />;

  return (
    <DetailView
      title={`Member (${member.role})`}
      subtitle={member.id}
      fields={memberDetailFields(member)}
      onBack={pop}
    />
  );
}
