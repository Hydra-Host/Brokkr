import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  DeviceJobsResponseSchema,
  JobLogsQuerySchema,
  JobLogsResponseSchema,
  JobSolLogsQuerySchema,
  JobSolLogsResponseSchema,
} from '../schemas/job-logs';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const jobLogsRoutes = c.router({
  getJobLogs: {
    method: 'GET',
    path: '/job-logs/:jobId',
    pathParams: z.object({ jobId: z.string().describe('Job ID whose log stream to read') }),
    query: JobLogsQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: JobLogsResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get operator log entries for a job',
    description:
      'Returns log entries streamed by the bridge and hub for a single job, in stream order with stream-ID cursor pagination. Requires the job-log:access permission and is restricted to the instance operator organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  listDeviceJobs: {
    method: 'GET',
    path: '/devices/:deviceId/jobs',
    pathParams: z.object({ deviceId: z.string().describe('Device whose jobs to list') }),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: DeviceJobsResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'List jobs recorded for a device',
    description:
      'Returns the jobs recorded for a device, newest first, so an operator can pick a job and view its logs. Requires the job-log:access permission and is restricted to the instance operator organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  getJobSolLogs: {
    method: 'GET',
    path: '/servers/:deviceId/jobs/:jobId/sol-logs',
    pathParams: z.object({
      deviceId: z.string().uuid().describe('Device whose serial console was captured'),
      jobId: z.string().uuid().describe('Job whose serial console capture to read'),
    }),
    query: JobSolLogsQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: JobSolLogsResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get serial console lines captured for a job',
    description:
      'Returns the serial-over-LAN lines the bridge captured for a single job, in capture order with list-offset pagination; each entry carries its absolute index in the list, and the list is kept for 24 hours after capture. Requires the job-log:access permission and is restricted to the instance operator organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
