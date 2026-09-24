import { DiscoveryIssuePhase, DiscoveryIssueSeverity, DiscoveryRunStatus } from '@repo/database/enums';
import { z } from 'zod';
import { createPaginatedResponseSchema, PaginationQuerySchema } from './pagination';
import { zodEnumFromPrisma } from './prisma-enum';

export const DiscoveryRunStatusSchema = zodEnumFromPrisma(DiscoveryRunStatus).describe(
  'Outcome of the discovery pass: STARTED while in flight, SUCCEEDED, PARTIAL when a collector or composer reported an issue, FAILED on a commit or orchestrator error, REJECTED when ingress refused the envelope',
);

export const DiscoveryIssuePhaseSchema = zodEnumFromPrisma(DiscoveryIssuePhase).describe(
  'Pipeline phase that raised the issue (INGRESS, SCHEMA, HANDLER, COMPOSER, COMMIT)',
);

export const DiscoveryIssueSeveritySchema = zodEnumFromPrisma(DiscoveryIssueSeverity).describe(
  'Severity the pipeline assigned to the issue (INFO, WARN, ERROR)',
);

export const DiscoveryRunIssueSchema = z.object({
  id: z.string().describe('Issue UUID'),
  phase: DiscoveryIssuePhaseSchema,
  collector: z
    .string()
    .nullable()
    .describe('Collector or composer the issue is attributed to; null for ingress and commit issues'),
  code: z.string().describe('Machine-readable issue code, for example PARSE_FAILED or HANDLER_THREW'),
  severity: DiscoveryIssueSeveritySchema,
  detail: z.unknown().describe('Free-form JSON detail recorded with the issue, when the recorder supplied one'),
  createdAt: z.string().describe('ISO 8601 timestamp recorded when the issue was raised'),
});

export type DiscoveryRunIssue = z.infer<typeof DiscoveryRunIssueSchema>;

export const DiscoveryRunSchema = z.object({
  id: z.string().describe('Discovery run UUID'),
  deviceId: z.string().describe('Device the discovery pass ran against'),
  status: DiscoveryRunStatusSchema,
  jobId: z.string().describe('Job ID that carried the discovery pass'),
  handlerVersion: z.string().describe('Hub build identifier that processed the run'),
  bridgeCollectorVersion: z.string().nullable().describe('Collector version reported by the bridge, when it sent one'),
  collectorsExpected: z.number().nullable().describe('Collector count the envelope announced'),
  collectorsReceived: z.number().nullable().describe('Collector payload count actually drained'),
  collectorsApplied: z.array(z.string()).describe('Collectors whose mutations were committed'),
  collectorsSkipped: z.array(z.string()).describe('Collectors that were received but not applied'),
  composersApplied: z.array(z.string()).describe('Cross-collector composers that ran'),
  s3Prefix: z.string().nullable().describe('S3 prefix holding the archived collector payloads, when uploaded'),
  startedAt: z.string().describe('ISO 8601 timestamp the run started'),
  completedAt: z.string().nullable().describe('ISO 8601 timestamp the run finished, or null while in flight'),
  durationMs: z.number().nullable().describe('Wall-clock run duration in milliseconds, or null while in flight'),
  issues: z.array(DiscoveryRunIssueSchema).describe('Issues recorded during the run, oldest first'),
});

export type DiscoveryRun = z.infer<typeof DiscoveryRunSchema>;

export const DiscoveryRunsQuerySchema = PaginationQuerySchema;

export type DiscoveryRunsQuery = z.infer<typeof DiscoveryRunsQuerySchema>;

export const DiscoveryRunsListResponseSchema = createPaginatedResponseSchema(DiscoveryRunSchema);

export type DiscoveryRunsListResponse = z.infer<typeof DiscoveryRunsListResponseSchema>;
