import { Box } from 'ink';
import React from 'react';
import type { CliApiClient } from '../core/client.js';
import { Header } from './components/header.js';
import { RouterProvider, useRouter } from './router.js';
import { AccountProfileScreen, AccountSshKeyDetailScreen, AccountSshKeysListScreen } from './screens/account.js';
import { BridgeDetailScreen, BridgesListScreen } from './screens/bridges.js';
import { DatacenterDetailScreen, DatacentersListScreen } from './screens/datacenters.js';
import { DeploymentDetailScreen, DeploymentsListScreen } from './screens/deployments.js';
import { HomeScreen } from './screens/home.js';
import { InventoryDetailScreen, InventoryListScreen } from './screens/inventory.js';
import { ApiKeyDetailScreen, ApiKeysListScreen } from './screens/org-api-keys.js';
import { InvitationDetailScreen, InvitationsListScreen } from './screens/org-invitations.js';
import { MemberDetailScreen, MembersListScreen } from './screens/org-members.js';
import { OrgSettingsScreen } from './screens/org-settings.js';
import {
  WebhookDeliveriesListScreen,
  WebhookDetailScreen,
  WebhooksListScreen,
  WebhookStatsScreen,
} from './screens/org-webhooks.js';
import { ProjectDeploymentsScreen, ProjectsListScreen } from './screens/projects.js';
import { ServerDetailScreen, ServersListScreen } from './screens/servers.js';

interface AppProps {
  client: CliApiClient;
  env: string;
  orgName: string;
}

function ScreenRouter({ client }: { client: CliApiClient }) {
  const { current } = useRouter();

  switch (current.screen) {
    case 'home':
      return <HomeScreen />;

    case 'datacenters':
      return <DatacentersListScreen client={client} />;
    case 'datacenter-detail':
      return <DatacenterDetailScreen client={client} id={current.params!.id!} />;
    case 'bridges':
      return <BridgesListScreen client={client} />;
    case 'bridge-detail':
      return <BridgeDetailScreen client={client} id={current.params!.id!} />;
    case 'deployments':
      return <DeploymentsListScreen client={client} />;
    case 'deployment-detail':
      return <DeploymentDetailScreen client={client} id={current.params!.id!} />;
    case 'projects':
      return <ProjectsListScreen client={client} />;
    case 'project-deployments':
      return <ProjectDeploymentsScreen client={client} id={current.params!.id!} />;
    case 'servers':
      return <ServersListScreen client={client} />;
    case 'decommissioned-servers':
      return <ServersListScreen client={client} role="Decommissioned" />;
    case 'server-detail':
      return <ServerDetailScreen client={client} id={current.params!.id!} />;
    case 'inventory-list':
      return <InventoryListScreen client={client} />;
    case 'inventory-detail':
      return <InventoryDetailScreen client={client} id={current.params!.id!} />;

    case 'org-settings':
      return <OrgSettingsScreen client={client} />;
    case 'org-members':
      return <MembersListScreen client={client} />;
    case 'org-member-detail':
      return <MemberDetailScreen client={client} id={current.params!.id!} />;
    case 'org-invitations':
      return <InvitationsListScreen client={client} />;
    case 'org-invitation-detail':
      return <InvitationDetailScreen client={client} id={current.params!.id!} />;
    case 'org-api-keys':
      return <ApiKeysListScreen client={client} />;
    case 'org-api-key-detail':
      return <ApiKeyDetailScreen client={client} id={current.params!.id!} />;
    case 'org-webhooks':
      return <WebhooksListScreen client={client} />;
    case 'org-webhook-detail':
      return <WebhookDetailScreen client={client} id={current.params!.id!} />;
    case 'org-webhook-deliveries':
      return <WebhookDeliveriesListScreen client={client} />;
    case 'org-webhook-stats':
      return <WebhookStatsScreen client={client} />;

    case 'account-profile':
      return <AccountProfileScreen client={client} />;
    case 'account-ssh-keys':
      return <AccountSshKeysListScreen client={client} />;
    case 'account-ssh-key-detail':
      return <AccountSshKeyDetailScreen client={client} id={current.params!.id!} />;

    default:
      return <HomeScreen />;
  }
}

export function App({ client, env, orgName }: AppProps) {
  return (
    <RouterProvider initial={{ screen: 'home', title: 'Home' }}>
      <Box flexDirection="column">
        <Header env={env} orgName={orgName} />
        <ScreenRouter client={client} />
      </Box>
    </RouterProvider>
  );
}
