import { Command } from 'commander';
import { Box, Text } from 'ink';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import {
  deploymentComputeFields,
  deploymentDetailFields,
  deploymentListColumns,
  deploymentNetworkingFields,
  deploymentStorageFields,
  lifecycleActionColumns,
} from '../../core/deployments/columns.js';
import { getDeployment, listDeployments } from '../../core/deployments/deployments.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { SectionFields } from '../../tui/components/section-fields.js';
import { StaticTable } from '../../tui/components/static-table.js';
import { renderOnce } from '../../tui/render-once.js';
import {
  fetchPage,
  paginationFooter,
  paginationOptions,
  renderJson,
  withSpinner,
  type PaginationFlags,
} from '../../ui/table.js';

export function registerDeploymentsCommand(parent: Command): Command {
  const cmd = parent
    .command('deployments')
    .alias('deploy')
    .description('List deployments, or show one by ID')
    .argument('[id]', 'Deployment ID to show details for');

  paginationOptions(cmd)
    .option('--project <name>', 'CLI-side filter by project name (case-insensitive substring)')
    .addHelpText(
      'after',
      `
Client-side filters (applied by the CLI after fetching):
  --project <name>   Case-insensitive substring match on the deployment's project name.
                     Only the current page is filtered; meta counts reflect the filtered set.

Default order (CLI-side):
  project name ascending, then device name ascending.

Examples:
  brokkr deployments --json                                List all deployments as JSON
  brokkr deployments --project "default" --json            Client-side filter by project name
  brokkr deployments <id> --json                           Get full deployment details`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags & { project?: string }, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showDeployment(id, flags.json);
      } else {
        await listDeploymentsAction(flags);
      }
    });

  return cmd;
}

async function listDeploymentsAction(flags: PaginationFlags & { project?: string }): Promise<void> {
  const result = await withSpinner('Fetching deployments...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage(
      (query) => listDeployments(client, { ...query, ...(flags.project ? { project: flags.project } : {}) }),
      flags,
    );
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Deployments"
      columns={deploymentListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr deployments')}
    />,
  );
}

async function showDeployment(deploymentId: string, json: boolean): Promise<void> {
  const deployment = await withSpinner(`Fetching deployment ${deploymentId}...`, async () => {
    const client = getAuthenticatedClient();
    return getDeployment(client, deploymentId);
  });

  if (json) {
    renderJson(deployment);
    return;
  }

  renderOnce(
    <DetailContent title={deployment.name} subtitle={deployment.id} fields={deploymentDetailFields(deployment)}>
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
    </DetailContent>,
  );
}
