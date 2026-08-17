import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import { orgSettingsDetailFields } from '../../core/org/columns.js';
import { getOrgSettings } from '../../core/org/settings.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { useAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function OrgSettingsScreen({ client }: { client: CliApiClient }) {
  const { pop } = useRouter();
  const { data, loading, error } = useAsync(() => getOrgSettings(client), []);

  if (loading) return <Loading message="Fetching organization settings..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!data) return <ErrorView message="No organization data" onBack={pop} />;

  return <DetailView title={data.name} subtitle={data.id} fields={orgSettingsDetailFields(data)} onBack={pop} />;
}
