import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import { deploymentListColumns, projectListColumns } from '../../core/deployments/columns.js';
import {
  getProjectDeployments,
  listDeploymentProjects,
  type DeploymentListItem,
  type DeploymentProject,
} from '../../core/deployments/deployments.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function ProjectsListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listDeploymentProjects(client, query),
  );

  if (loading) return <Loading message="Fetching projects..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<DeploymentProject>
      columns={projectListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'project-deployments', params: { id: row.id }, title: row.name })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function ProjectDeploymentsScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { push, pop } = useRouter();
  const { data, loading, error } = useAsync(() => getProjectDeployments(client, id), [id]);

  if (loading) return <Loading message="Fetching deployments..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<DeploymentListItem>
      columns={deploymentListColumns}
      rows={data ?? []}
      onSelect={(row) => push({ screen: 'deployment-detail', params: { id: row.id }, title: row.name })}
      onBack={pop}
    />
  );
}
