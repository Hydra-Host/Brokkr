import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import { orgSettingsDetailFields } from '../../core/org/columns.js';
import { getOrgSettings } from '../../core/org/settings.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { renderOnce } from '../../tui/render-once.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerSettingsCommand(parent: Command): void {
  parent
    .command('settings')
    .description('Show organization settings')
    .option('--json', 'Output as JSON', false)
    .action(async (flags: { json: boolean }) => {
      const settings = await withSpinner('Fetching organization settings...', async () => {
        const client = getAuthenticatedClient();
        return getOrgSettings(client);
      });

      if (flags.json) {
        renderJson(settings);
        return;
      }

      renderOnce(
        <DetailContent title={settings.name} subtitle={settings.id} fields={orgSettingsDetailFields(settings)} />,
      );
    });
}
