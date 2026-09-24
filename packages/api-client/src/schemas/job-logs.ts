import { z } from 'zod';

export const JobLogEntrySchema = z.object({
  id: z.string().describe('Redis stream entry ID, usable as a pagination cursor'),
  timestamp: z.string().describe('ISO 8601 timestamp recorded when the line was emitted'),
  logLevel: z.string().describe('Log level of the entry (debug, info, warning, error)'),
  message: z.string().describe('Log line text'),
  appName: z.string().describe('Emitting application (bridge-api or brokkr-hub)'),
  appClassName: z.string().describe('Emitting service or class name'),
});

export type JobLogEntry = z.infer<typeof JobLogEntrySchema>;

export const JobLogsQuerySchema = z.object({
  cursor: z
    .string()
    .optional()
    .describe('Stream ID of the last entry from the previous page; entries strictly after it are returned'),
  limit: z.coerce.number().int().min(1).max(1000).default(500).describe('Maximum entries to return per page'),
});

export type JobLogsQuery = z.infer<typeof JobLogsQuerySchema>;

export const JobLogsResponseSchema = z.object({
  entries: z.array(JobLogEntrySchema).describe('Log entries in stream order (oldest first)'),
  nextCursor: z.string().nullable().describe('Cursor for the next page, or null when the page was not full'),
});

export type JobLogsResponse = z.infer<typeof JobLogsResponseSchema>;

export const DeviceJobSchema = z.object({
  id: z.string().describe('Job ID (the saga plan ID keying the log stream)'),
  jobType: z
    .string()
    .describe(
      'Job type (Provision, Reprovision, Reboot, PowerOn, PowerOff, Deprovision, Interrupted, Commission, Decommission)',
    ),
  status: z
    .string()
    .describe(
      'Job status: a lifecycle phase (REQUESTED, RUNNING, COMPLETED, FAILED, ...) or a legacy status (Pending, InProgress, Completed, Failed)',
    ),
  createdAt: z.string().describe('ISO 8601 creation timestamp'),
  error: z.string().nullable().describe('Failure detail when the job failed, or null'),
});

export type DeviceJob = z.infer<typeof DeviceJobSchema>;

export const DeviceJobsResponseSchema = z.object({
  jobs: z.array(DeviceJobSchema).describe('Jobs for the device, newest first'),
});

export type DeviceJobsResponse = z.infer<typeof DeviceJobsResponseSchema>;

export const JobSolLogEntrySchema = z.object({
  index: z
    .number()
    .int()
    .nonnegative()
    .describe('Absolute offset of the line in the serial console list, usable as the next cursor'),
  timestamp: z.string().describe('ISO 8601 timestamp recorded by the bridge when the line was captured'),
  message: z.string().describe('Serial console line text'),
});

export type JobSolLogEntry = z.infer<typeof JobSolLogEntrySchema>;

export const JobSolLogsQuerySchema = z.object({
  cursor: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('List offset to start reading from; 0 reads from the first captured line'),
  limit: z.coerce.number().int().min(1).max(1000).default(500).describe('Maximum entries to return per page'),
});

export type JobSolLogsQuery = z.infer<typeof JobSolLogsQuerySchema>;

export const JobSolLogsResponseSchema = z.object({
  entries: z.array(JobSolLogEntrySchema).describe('Serial console lines in capture order (oldest first)'),
  nextCursor: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('List offset for the next page, or null when the page was not full'),
  complete: z.boolean().describe('Whether the bridge has finished capturing the serial console for this job'),
});

export type JobSolLogsResponse = z.infer<typeof JobSolLogsResponseSchema>;
