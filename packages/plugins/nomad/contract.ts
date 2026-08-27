import { API_PREFIX } from '@hydrahost/plugin-sdk';
import { initContract } from '@ts-rest/core';

import {
  NomadAllocsQuerySchema,
  NomadAllocsResultSchema,
  NomadDispatchRequestSchema,
  NomadDispatchResultSchema,
  NomadHealthResponseSchema,
  NomadJobQuerySchema,
  NomadJobReadResultSchema,
  NomadJobRequestSchema,
  NomadLogsQuerySchema,
  NomadLogsResultSchema,
  NomadNodesQuerySchema,
  NomadNodesResultSchema,
  NomadPlanResultSchema,
  NomadStartupStatusSchema,
  NomadStatusQuerySchema,
  NomadStopRequestSchema,
  NomadStopResultSchema,
  NomadSubmitResultSchema,
  NomadValidateResultSchema,
} from './schemas';

const c = initContract();

/** ts-rest fragment for plugin id `nomad` (keys uniquely prefixed). */
export const contractFragment = c.router(
  {
    nomadHealth: {
      method: 'GET',
      path: '/plugins/nomad/health',
      responses: { 200: NomadHealthResponseSchema },
      summary: 'Nomad plugin health stub',
      description: 'Liveness endpoint. Returns a static ok payload; does not contact Nomad.',
      metadata: { visibility: 'internal' as const },
    },
    nomadValidate: {
      method: 'POST',
      path: '/plugins/nomad/validate',
      body: NomadJobRequestSchema,
      responses: { 200: NomadValidateResultSchema },
      summary: 'Parse and validate a Nomad job',
      description:
        'Loads a shipped jobspec (or uses jobHCL/job), parses when needed, and calls Nomad validate. ' +
        'Failures are returned as status:error bodies when possible. Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadPlan: {
      method: 'POST',
      path: '/plugins/nomad/plan',
      body: NomadJobRequestSchema,
      responses: { 200: NomadPlanResultSchema },
      summary: 'Dry-run plan a Nomad job',
      description:
        'Parses when needed, then plans against the Nomad scheduler. failedPlacements is informational. ' +
        'Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadSubmit: {
      method: 'POST',
      path: '/plugins/nomad/submit',
      body: NomadJobRequestSchema,
      responses: { 200: NomadSubmitResultSchema },
      summary: 'Register or update a Nomad job',
      description:
        'Parses when needed, then POSTs to /v1/jobs (create-or-update by job ID from the Job JSON). ' +
        'Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadStatus: {
      method: 'GET',
      path: '/plugins/nomad/status',
      query: NomadStatusQuerySchema,
      responses: { 200: NomadStartupStatusSchema },
      summary: 'One-shot job startup status snapshot',
      description:
        'Reads allocations + job spec once and returns a startup verdict. Caller owns polling cadence. ' +
        'Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadDispatch: {
      method: 'POST',
      path: '/plugins/nomad/dispatch',
      body: NomadDispatchRequestSchema,
      responses: { 200: NomadDispatchResultSchema },
      summary: 'Dispatch a parameterized Nomad job',
      description:
        'POST /v1/job/:jobId/dispatch with optional Meta and a base64-encoded Payload. Returns the ' +
        'dispatched child job ID and evaluation ID. Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadLogs: {
      method: 'GET',
      path: '/plugins/nomad/logs',
      query: NomadLogsQuerySchema,
      responses: { 200: NomadLogsResultSchema },
      summary: 'Single-shot task log tail for an allocation',
      description:
        'GET /v1/client/fs/logs/:allocId with plain=true, follow=false — a bounded text read, not a ' +
        'stream. origin=start|end (default end) and offset bytes (default 16384). Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadAllocs: {
      method: 'GET',
      path: '/plugins/nomad/allocs',
      query: NomadAllocsQuerySchema,
      responses: { 200: NomadAllocsResultSchema },
      summary: 'List allocations for a Nomad job',
      description:
        'GET /v1/job/:jobId/allocations with per-task state summaries. Supports dispatched child job ' +
        'IDs (path segments are URL-encoded). Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadJob: {
      method: 'GET',
      path: '/plugins/nomad/job',
      query: NomadJobQuerySchema,
      responses: { 200: NomadJobReadResultSchema },
      summary: 'Read a registered Nomad job spec',
      description:
        'GET /v1/job/:jobId mapped to task-group task Config/Resources/Env for deploy prefill ' +
        '("read from server"). Path segments are URL-encoded. Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadNodes: {
      method: 'GET',
      path: '/plugins/nomad/nodes',
      query: NomadNodesQuerySchema,
      responses: { 200: NomadNodesResultSchema },
      summary: 'List Nomad client nodes (or read one with meta)',
      description:
        'GET /v1/nodes list stubs (no meta). With nodeId, reads GET /v1/node/:id and returns a ' +
        'single-element list including node Meta. Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
    nomadStop: {
      method: 'POST',
      path: '/plugins/nomad/stop',
      body: NomadStopRequestSchema,
      responses: { 200: NomadStopResultSchema },
      summary: 'Stop/deregister a Nomad job',
      description:
        'DELETE /v1/job/{jobId} on the customer Nomad cluster. purge=false stops and deregisters ' +
        '(same ID can be re-registered); purge=true also removes GC history. Instance-operator only.',
      metadata: { visibility: 'internal' as const },
    },
  },
  { pathPrefix: API_PREFIX },
);

export {
  NomadAllocsQuerySchema,
  NomadAllocsResultSchema,
  NomadAllocSummarySchema,
  NomadAllocTaskStateSchema,
  NomadDispatchRequestSchema,
  NomadDispatchResultSchema,
  NomadHealthResponseSchema,
  NomadJobQuerySchema,
  NomadJobReadResultSchema,
  NomadJobRequestSchema,
  NomadJobTaskGroupSchema,
  NomadJobTaskSchema,
  NomadLogsQuerySchema,
  NomadLogsResultSchema,
  NomadNodeSchema,
  NomadNodesQuerySchema,
  NomadNodesResultSchema,
  NomadPlanResultSchema,
  NomadStartupStatusSchema,
  NomadStatusQuerySchema,
  NomadStopRequestSchema,
  NomadStopResultSchema,
  NomadSubmitResultSchema,
  NomadValidateResultSchema,
} from './schemas';
