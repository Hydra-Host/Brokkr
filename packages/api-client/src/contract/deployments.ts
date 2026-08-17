import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  DeploymentActionResponseSchema,
  DeploymentSchema,
  GetLogsRequestSchema,
  InterruptibleClaimSchema,
  PowerControlDeploymentRequestSchema,
  PowerCycleDeploymentRequestSchema,
  RebootDeploymentRequestSchema,
  ReprovisionDeploymentRequestSchema,
  SolLogsResponseSchema,
  UpdateDeploymentRequestSchema,
} from '../schemas/deployments';
import { ErrorResponseSchema } from '../schemas/index';
import { LifecycleRequestResponseSchema } from '../schemas/lifecycle-requests';
import { createPaginatedResponseSchema, PaginationQuerySchema } from '../schemas/pagination';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const deploymentsRoutes = c.router({
  getDeployments: {
    method: 'GET',
    path: '/deployments',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(DeploymentSchema),
    },
    summary: 'Get all deployments',
    description: 'Returns a paginated list of all deployments belonging to the current organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getDeploymentById: {
    method: 'GET',
    path: '/deployments/:id',
    pathParams: z.object({ id: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: DeploymentSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get deployment by ID',
    description:
      'Returns full details for a single deployment, including specs, networking, storage layouts, and lifecycle history.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateDeploymentNickname: {
    method: 'PATCH',
    path: '/deployments/:id',
    pathParams: z.object({ id: z.string() }),
    body: UpdateDeploymentRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: DeploymentSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update deployment nickname',
    description: 'Updates the customer-facing display name (nickname) for a deployment.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  reprovisionDeployment: {
    method: 'PATCH',
    path: '/deployments/:id/reprovision',
    pathParams: z.object({ id: z.string() }),
    body: ReprovisionDeploymentRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Reprovision deployment',
    description:
      'Wipes and reinstalls the operating system on a deployment with new OS, SSH keys, and disk layout configuration. The deployment must not be locked.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  rebootDeployment: {
    method: 'PATCH',
    path: '/deployments/:id/reboot',
    pathParams: z.object({ id: z.string() }),
    body: RebootDeploymentRequestSchema,
    deprecated: true,
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Reboot deployment',
    description: 'Deprecated: Use the power-cycle endpoint instead.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  powerCycleDeployment: {
    method: 'PATCH',
    path: '/deployments/:id/power-cycle',
    pathParams: z.object({ id: z.string() }),
    body: PowerCycleDeploymentRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Power cycle deployment',
    description:
      'Performs a hard power cycle on the device. This is equivalent to physically unplugging and re-plugging the machine.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  powerControlDeployment: {
    method: 'PATCH',
    path: '/deployments/:id/power-control',
    pathParams: z.object({ id: z.string() }),
    body: PowerControlDeploymentRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Power control for deployment',
    description: 'Turns a device on or off via IPMI. Use "on" to power up and "off" to shut down.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deprovisionDeployment: {
    method: 'DELETE',
    path: '/deployments/:id/deprovision',
    pathParams: z.object({ id: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Deprovision deployment',
    description:
      'Permanently deprovisions a deployment, releasing the device back to the supplier. This action is irreversible and the deployment must not be locked.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  activateRescueMode: {
    method: 'POST',
    path: '/deployments/:id/rescue-mode/activate',
    pathParams: z.object({ id: z.string() }),
    body: z.object({}),
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Activate rescue mode for device',
    description:
      'Boots the device into a temporary rescue operating system for diagnostics and recovery. Returns 400 if rescue mode is already active.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deactivateRescueMode: {
    method: 'POST',
    path: '/deployments/:id/rescue-mode/deactivate',
    pathParams: z.object({ id: z.string() }),
    body: z.object({}),
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Deactivate rescue mode for device',
    description:
      'Exits rescue mode and reboots the device back into its primary operating system. Returns 400 if rescue mode is not active.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getLogs: {
    method: 'POST',
    path: '/deployments/:id/logs',
    pathParams: z.object({ id: z.string() }),
    body: GetLogsRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: SolLogsResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get SOL logs for provision or reprovision job',
    description:
      'Retrieves serial-over-LAN (SOL) logs streamed by the bridge during provisioning. Returns the log entries inline along with a flag indicating whether streaming is complete.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  toggleDeploymentLock: {
    method: 'PATCH',
    path: '/deployments/:id/toggle-lock',
    pathParams: z.object({ id: z.string() }),
    body: z.object({}),
    responses: {
      ...authedErrorResponses,
      200: DeploymentActionResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Toggle deployment lock',
    description:
      'Toggles the lock state of a deployment. When locked, destructive actions like deprovision and reprovision are prevented.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getInterruptibleClaims: {
    method: 'GET',
    path: '/deployments/interruptible-claims',
    query: PaginationQuerySchema.extend({ status: z.enum(['Pending', 'Complete']).optional() }),
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(InterruptibleClaimSchema),
      404: ErrorResponseSchema,
    },
    summary: 'Get interruptible claims for organization',
    description:
      'Returns a paginated list of interruptible claims for the organization. Optionally filter by claim status.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getLifecycleRequests: {
    method: 'GET',
    path: '/deployments/:id/lifecycle-requests',
    pathParams: z.object({ id: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: z.array(LifecycleRequestResponseSchema),
      404: ErrorResponseSchema,
    },
    summary: 'List lifecycle requests for a deployment',
    description:
      'Returns all pending and historical admin lifecycle requests for a specific deployment. Only visible to members of the organization that owns the deployment.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  approveLifecycleRequest: {
    method: 'PATCH',
    path: '/deployments/:id/lifecycle-requests/:requestId/approve',
    pathParams: z.object({ id: z.string(), requestId: z.string() }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: DeploymentActionResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Approve a lifecycle request',
    description:
      'Customer approves a pending lifecycle request, allowing the operator to execute the requested destructive action. Requires lifecycle-request:approve.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  rejectLifecycleRequest: {
    method: 'PATCH',
    path: '/deployments/:id/lifecycle-requests/:requestId/reject',
    pathParams: z.object({ id: z.string(), requestId: z.string() }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: DeploymentActionResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Reject a lifecycle request',
    description:
      'Customer rejects a pending lifecycle request. The requested destructive action will not be executed. Requires lifecycle-request:approve.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
