import { z } from 'zod';
import { AppLinkSchema, ServiceSchema } from '../schemas/common';

export const servicesRoutes = {
  listServices: {
    method: 'GET',
    path: '/api/services',
    responses: { 200: z.array(ServiceSchema) },
    summary: 'List supervised services',
    description:
      'Read-only snapshot of each supervised process-compose service (hub and spoke) used to render the services panel; reports both the process run state and its health-probe readiness.',
  },
  listAppLinks: {
    method: 'GET',
    path: '/api/services/app-links',
    responses: { 200: z.array(AppLinkSchema) },
    summary: 'List web-UI app links',
    description:
      'Web UIs auto-discovered from process-compose LAB_WEB_UI markers — returns port, path, readiness, and loopback-only binding for each discovered UI; drives the sidebar Apps section.',
  },
  controlService: {
    method: 'POST',
    path: '/api/services/control',
    body: z.object({ id: z.string(), action: z.enum(['start', 'stop', 'restart']) }),
    responses: {
      200: z.object({ ok: z.boolean(), detail: z.string().optional() }),
    },
    summary: 'Start/stop/restart a service',
    description:
      'Issues the lifecycle action to process-compose and returns once it is accepted; watch the per-service SSE log stream at /api/services/:id/log for progress. An unknown id returns 200 with ok=false and a detail. Loopback-only (it starts and stops host processes): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  reloadService: {
    method: 'POST',
    path: '/api/services/reload',
    body: z.object({ group: z.enum(['hub', 'spoke']) }),
    responses: {
      200: z.object({
        runId: z
          .string()
          .describe('Run id of the reload run — appears in listRuns; logs stream over SSE at /api/runs/:runId/stream'),
      }),
    },
    summary: 'Reload one service group',
    description:
      'Use after editing stack config to roll just the hub or spoke group: applies the stack.local.nix overrides, regenerates the process-compose config, runs project update, and restarts that group without touching the rest of the stack; logs stream over SSE at /api/runs/:runId/stream. Loopback-only (it restarts host processes): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
} as const;
