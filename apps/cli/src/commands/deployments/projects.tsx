import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import { projectListColumns } from '../../core/deployments/columns.js';
import { listDeploymentProjects } from '../../core/deployments/deployments.js';
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

export function registerProjectsCommand(parent: Command): void {
  paginationOptions(parent.command('deployments:projects').description('List deployment projects'))
    .addHelpText(
      'after',
      `
Examples:
  brokkr deployments:projects                 List projects
  brokkr deployments:projects --json          List projects as JSON`,
    )
    .action(async (flags: PaginationFlags) => {
      const result = await withSpinner('Fetching projects...', async () => {
        const client = getAuthenticatedClient();
        return fetchPage((query) => listDeploymentProjects(client, query), flags);
      });

      if (flags.json) {
        renderJson(result);
        return;
      }

      renderOnce(
        <StaticTable
          title="Projects"
          columns={projectListColumns}
          rows={result.data}
          footer={paginationFooter(result.meta, 'brokkr deployments:projects')}
        />,
      );
    });
}
