import { Box, Text } from 'ink';
import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import {
  deploymentComputeFields,
  deploymentDetailFields,
  deploymentListColumns,
  deploymentNetworkingFields,
  deploymentStorageFields,
  lifecycleActionColumns,
} from '../../core/deployments/columns.js';
import { getDeployment, listDeployments, type DeploymentListItem } from '../../core/deployments/deployments.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { SectionFields } from '../components/section-fields.js';
import { StaticTable } from '../components/static-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function DeploymentsListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listDeployments(client, query),
  );

  if (loading) return <Loading message="Fetching deployments..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<DeploymentListItem>
      columns={deploymentListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'deployment-detail', params: { id: row.id }, title: row.name })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function DeploymentDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: deployment, loading, error } = useAsync(() => getDeployment(client, id), [id]);

  if (loading) return <Loading message="Loading deployment..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!deployment) return <ErrorView message="Deployment not found" onBack={pop} />;

  return (
    <DetailView
      title={deployment.name}
      subtitle={deployment.id}
      fields={deploymentDetailFields(deployment)}
      onBack={pop}
    >
      <SectionFields title="Compute" fields={deploymentComputeFields(deployment)} />
      <SectionFields title="Storage" fields={deploymentStorageFields(deployment)} />
      <SectionFields title="Networking" fields={deploymentNetworkingFields(deployment)} />
      {deployment.sshKeys.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={0}>
            <Text bold color="cyan">
              SSH Keys
            </Text>
          </Box>
          {deployment.sshKeys.map((key, i) => (
            <Box key={i}>
              <Text>
                {' '}
                {key.name} ({key.user})
              </Text>
            </Box>
          ))}
        </>
      )}
      {deployment.lifecycleActions.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={0}>
            <Text bold color="cyan">
              Lifecycle Actions
            </Text>
          </Box>
          <StaticTable columns={lifecycleActionColumns} rows={deployment.lifecycleActions} />
        </>
      )}
      {deployment.availableBaseLayers.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={0}>
            <Text bold color="cyan">
              Available Base Layers
            </Text>
          </Box>
          {deployment.availableBaseLayers.map((l, i) => (
            <Box key={i}>
              <Text>
                {' '}
                {l.name} ({l.slug})
              </Text>
            </Box>
          ))}
        </>
      )}
    </DetailView>
  );
}
