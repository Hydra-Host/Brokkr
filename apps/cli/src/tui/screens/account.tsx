import React from 'react';
import { profileDetailFields, sshKeyDetailFields, sshKeyListColumns } from '../../core/account/columns.js';
import { getProfile } from '../../core/account/profile.js';
import { getSshKey, listSshKeys, type SshKeyListItem } from '../../core/account/ssh-keys.js';
import type { CliApiClient } from '../../core/client.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function AccountProfileScreen({ client: _client }: { client: CliApiClient }) {
  const { pop } = useRouter();
  const { data: profile, loading, error } = useAsync(() => getProfile(), []);

  if (loading) return <Loading message="Fetching profile..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!profile) return <ErrorView message="Profile not found" onBack={pop} />;

  return <DetailView title="User Profile" subtitle={profile.id} fields={profileDetailFields(profile)} onBack={pop} />;
}

export function AccountSshKeysListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listSshKeys(client, query),
  );

  if (loading) return <Loading message="Fetching SSH keys..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<SshKeyListItem>
      columns={sshKeyListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'account-ssh-key-detail', params: { id: row.id }, title: row.name })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function AccountSshKeyDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: key, loading, error } = useAsync(() => getSshKey(client, id), [id]);

  if (loading) return <Loading message="Loading SSH key..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!key) return <ErrorView message="SSH key not found" onBack={pop} />;

  return <DetailView title={key.name} subtitle={key.id} fields={sshKeyDetailFields(key)} onBack={pop} />;
}
