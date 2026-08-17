import { z } from 'zod';

export const sagaNames = [
  'benchmarks',
  'provision',
  'deprovision',
  'commission',
  'redfish',
  'network_scan',
  'enrich_via_pxe',
  'inventory_collection',
  'ipxe_build',
  'sync',
  'reboot',
  'power_on',
  'power_off',
  'power_status',
  'device_health_check',
  'bmc_reset',
  'secret_reveal',
] as const;

export type SagaName = (typeof sagaNames)[number];

export const JOB_NAME = {
  SAGA_RUN: 'saga.run',
} as const;

export const RESULT_JOB_NAME = {
  JOB_RESULT: 'job.result',
  JOB_COMPLETED: 'job.completed',
  DISCOVERY_COMPLETE: 'discovery.complete',
  DEVICE_HEALTH: 'device_health',
  DEVICE_PHONE_HOME: 'device.phone_home',
  RENDER_REQUEST: 'render.request',
  SECRET_REVEALED: 'secret.revealed',
} as const;

export type ResultJobName = (typeof RESULT_JOB_NAME)[keyof typeof RESULT_JOB_NAME];

const resultJobNames: ReadonlySet<string> = new Set(Object.values(RESULT_JOB_NAME));

export function isResultJobName(name: string): name is ResultJobName {
  return resultJobNames.has(name);
}

/** Bridges stamp results with `Date.now() / 1000` — epoch SECONDS, carried over from the Python
 *  bridge's `time.time()`. `new Date()` takes milliseconds, so the unit must be converted here. */
const BRIDGE_TIMESTAMP_UNIT = 'Epoch seconds (not milliseconds) — the bridge sends Date.now() / 1000';

export function bridgeTimestampToDate(seconds: number): Date {
  return new Date(seconds * 1000);
}

export const sagaJobDataSchema = z.object({
  plan_id: z.string(),
  saga_name: z.enum(sagaNames),
  payload: z.record(z.unknown()),
  device_id: z.string(),
});

export type SagaJobData = z.infer<typeof sagaJobDataSchema>;

export const jobResultDataSchema = z.object({
  plan_id: z.string(),
  step_name: z.string(),
  status: z.string(),
  device_id: z.string(),
  zone_prefix: z.string(),
  event_type: z.enum(['stage_changed', 'job_failed', 'job_completed', 'job_blocked']),
  action_type: z.string(),
  result: z.record(z.unknown()).nullable().optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
  attempt: z.number().default(0),
  metadata: z.record(z.unknown()).nullable().optional(),
  timestamp: z.number().describe(BRIDGE_TIMESTAMP_UNIT),
});

export type JobResultData = z.infer<typeof jobResultDataSchema>;

export const jobCompletedDataSchema = z.object({
  plan_id: z.string(),
  device_id: z.string(),
  zone_prefix: z.string(),
  saga_name: z.string(),
  status: z.string(),
  duration_seconds: z.number().nullable().optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  timestamp: z.number().describe(BRIDGE_TIMESTAMP_UNIT),
});

export type JobCompletedData = z.infer<typeof jobCompletedDataSchema>;

export const deviceHealthDataSchema = z.object({
  job_id: z.string(),
  device_id: z.string(),
  zone_prefix: z.string(),
  primary_reachable: z.boolean().nullable().optional(),
  bmc_icmp_reachable: z.boolean().nullable().optional(),
  bmc_ipmi_reachable: z.boolean().nullable().optional(),
  bmc_redfish_reachable: z.boolean().nullable().optional(),
  bmc_creds_valid: z.boolean().nullable().optional(),
  powered_on: z.boolean().nullable().optional(),
  brokkr_live_running: z.boolean().nullable().optional(),
});

export const phoneHomeDataSchema = z.object({
  device_id: z.string(),
  zone_prefix: z.string(),
  boot_id: z.string(),
  timestamp: z.number().describe(BRIDGE_TIMESTAMP_UNIT),
});

export const benchmarkStepResultSchema = z.object({
  test_run_id: z.string(),
  test_passed: z.boolean(),
  data: z.record(z.unknown()),
});

export const sanitizationReportSchema = z.object({
  version: z.string().optional(),
  standards_reference: z.array(z.string()).optional(),
  job_id: z.string().optional(),
  mode: z.string().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  duration_seconds: z.number().optional(),
  overall_result: z.string().optional(),
  tool: z.object({ name: z.string(), version: z.string() }).partial().optional(),
  holder_teardown: z.record(z.unknown()).optional(),
  disks: z.array(z.record(z.unknown())).optional(),
  preserved_disks: z.array(z.record(z.unknown())).optional(),
  skipped_disks: z.array(z.record(z.unknown())).optional(),
});

export type SanitizationReport = z.infer<typeof sanitizationReportSchema>;

export const WIPE_STEP_NAMES = ['wipe_disks', 'disk_wipe'] as const;
