import { initContract } from '@ts-rest/core';
import { API_PREFIX } from '../version';
import { apiKeysRoutes } from './api-keys';
import { appRoutes } from './app';
import { asnRoutes } from './asn';
import { baremetalRoutes } from './baremetal';
import { bgpRoutes } from './bgp';
import { bmcRequestsRoutes } from './bmc-requests';
import { cduRoutes } from './cdus';
import { circuitsRoutes } from './circuits';
import { cloudInitTemplatesRoutes } from './cloud-init-templates';
import { commissioningRoutes } from './commissioning';
import { dcimRoutes } from './dcim';
import { dcimBridgesRoutes } from './dcim-bridges';
import { deploymentsRoutes } from './deployments';
import { deploymentsProjectsRoutes } from './deployments-projects';
import { deviceModelsRoutes } from './device-models';
import { deviceSecretRoutes } from './device-secrets';
import { deviceTokensRoutes } from './device-tokens';
import { devicesNetplanRoutes } from './devices-netplan';
import { prefixDnsRoutes, zoneDnsRoutes } from './dns';
import { dnsRecordsRoutes } from './dns-records';
import { eventLogRoutes } from './event-log';
import { gatewaysRoutes } from './gateways';
import { interruptibleEvictionsRoutes } from './interruptible-evictions';
import { inventoryRoutes } from './inventory';
import { ipamRoutes } from './ipam';
import { ipamRolesRoutes } from './ipam-roles';
import { organizationRoutes } from './organizations';
import { pduRoutes } from './pdus';
import { pluginsRoutes } from './plugins';
import { rackRolesRoutes } from './rack-roles';
import { regionsRoutes } from './regions';
import { reservationInvitesRoutes } from './reservation-invites';
import { routerRoutes } from './routers';
import { sshkeysRoutes } from './sshkeys';
import { switchRoutes } from './switches';
import { tagsRoutes } from './tags';
import { telemetryRoutes } from './telemetry';
import { usersRoutes } from './users';
import { vlanGroupsRoutes } from './vlan-groups';
import { webhooksRoutes } from './webhooks';
import { zoneCryptoRoutes } from './zone-crypto';
import { zoneServiceTuningRoutes } from './zone-service-tuning';
import { zonesRoutes } from './zones';

const c = initContract();
const options = { pathPrefix: API_PREFIX, strictStatusCodes: true } as const;

const coreContract = c.router(
  {
    ...apiKeysRoutes,
    ...appRoutes,
    ...asnRoutes,
    ...baremetalRoutes,
    ...bmcRequestsRoutes,
    ...cloudInitTemplatesRoutes,
    ...devicesNetplanRoutes,
    ...bgpRoutes,
    ...circuitsRoutes,
    ...dcimRoutes,
    ...dcimBridgesRoutes,
    ...cduRoutes,
    ...pduRoutes,
    ...switchRoutes,
    ...routerRoutes,
  },
  options,
);

const infraContract = c.router(
  {
    ...deploymentsRoutes,
    ...deploymentsProjectsRoutes,
    ...deviceModelsRoutes,
    ...deviceTokensRoutes,
    ...gatewaysRoutes,
    ...interruptibleEvictionsRoutes,
    ...ipamRolesRoutes,
    ...ipamRoutes,
    ...prefixDnsRoutes,
    ...inventoryRoutes,
    ...commissioningRoutes,
    ...organizationRoutes,
  },
  options,
);

const platformContract = c.router(
  {
    ...zoneDnsRoutes,
    ...zoneServiceTuningRoutes,
    ...pluginsRoutes,
    ...rackRolesRoutes,
    ...regionsRoutes,
    ...reservationInvitesRoutes,
    ...sshkeysRoutes,
    ...tagsRoutes,
    ...telemetryRoutes,
    ...usersRoutes,
    ...vlanGroupsRoutes,
    ...webhooksRoutes,
    ...eventLogRoutes,
    ...deviceSecretRoutes,
    ...dnsRecordsRoutes,
    ...zoneCryptoRoutes,
    ...zonesRoutes,
  },
  options,
);

export type AppContract = typeof coreContract & typeof infraContract & typeof platformContract;

export const contract: AppContract = {
  ...coreContract,
  ...infraContract,
  ...platformContract,
};

export type { RouteMetadata, RouteVisibility } from './metadata';
