import { initContract } from '@ts-rest/core';
import { auditRoutes } from './contract/audit';
import { buildRoutes } from './contract/build';
import { datastoreRoutes } from './contract/datastore';
import { fleetRoutes } from './contract/fleet';
import { hubRoutes } from './contract/hub';
import { queuesRoutes } from './contract/queues';
import { runsRoutes } from './contract/runs';
import { runtimeRoutes } from './contract/runtime';
import { servicesRoutes } from './contract/services';
import { stackRoutes } from './contract/stack';
import { stacksRoutes } from './contract/stacks';
import { statusRoutes } from './contract/status';
import { storageRoutes } from './contract/storage';
import { sudoRoutes } from './contract/sudo';
import { testRoutes } from './contract/test';
import { zonesRoutes } from './contract/zones';

const c = initContract();

// Never imported by @repo/api-client — the control-center surface must not reach the production client.
export const contract = c.router(
  {
    ...statusRoutes,
    ...runsRoutes,
    ...stackRoutes,
    ...stacksRoutes,
    ...servicesRoutes,
    ...fleetRoutes,
    ...zonesRoutes,
    ...testRoutes,
    ...datastoreRoutes,
    ...queuesRoutes,
    ...runtimeRoutes,
    ...hubRoutes,
    ...buildRoutes,
    ...storageRoutes,
    ...sudoRoutes,
    ...auditRoutes,
  },
  { strictStatusCodes: true },
);

export * from './apply-action';
export * from './apply-class';
export * from './ipv4';
export * from './schemas/audit';
export * from './schemas/common';
export * from './schemas/datastore';
export * from './schemas/fleet';
export * from './schemas/hub';
export * from './schemas/queues';
export * from './schemas/runs';
export * from './schemas/runtime';
export * from './schemas/stack';
export * from './schemas/stacks';
export * from './schemas/status';
export * from './schemas/storage';
export * from './schemas/sudo';
export * from './schemas/test';
export * from './schemas/zones';
export * from './streams';
export * from './writable';
