import { z } from 'zod';

export const TestScenarioSchema = z.object({
  id: z.string().describe('Stable scenario id'),
  label: z.string().describe('Human label'),
  description: z.string().describe('What the scenario runs, shown in the info popover'),
  pinNode: z.boolean().describe('Whether the scenario accepts a target node (SIM_LC_DEVICE_INDEX)'),
  destructive: z.boolean().describe('Whether it drives a destructive saga (provision/deprovision)'),
  picker: z
    .enum(['layers', 'cloudinit', 'rescue', 'baseos', 'ipxe', 'disklayout', 'plan'])
    .optional()
    .describe('Opens a custom pre-run picker instead of running immediately'),
  steps: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional()
    .describe(
      'Optional sub-steps the user can multi-select in the confirm modal (passed to the vitest suite as SIM_LC_STEPS=a,b)',
    ),
  disabled: z.boolean().optional().describe('When true the scenario is shown greyed out and cannot be launched'),
  disabledReason: z.string().optional().describe('Human-readable reason the scenario is disabled'),
});
export type TestScenario = z.infer<typeof TestScenarioSchema>;

export const StorageDiskSchema = z.object({
  name: z.string().describe('Device name as the booted OS sees it (e.g. sda, nvme0n1)'),
  serial: z.string().nullable().optional(),
  wwn: z.string().nullable().optional(),
});
export const StorageConfigSchema = z.object({
  disk_group_name: z.string().describe('Group identifier (e.g. SSD_480GB, NVME_7681GB)'),
  disk_type: z.string().describe('ssd | hdd | nvme'),
  capabilities: z
    .array(z.string())
    .describe('Configs this group can apply: direct | lvm | raid0 | raid1 | raid10 | raid5 | raid6'),
  file_systems: z.array(z.string()).default([]).describe('Filesystems this group offers (ext4 | xfs)'),
  disks: z.array(StorageDiskSchema).default([]),
  num_disks: z.number().optional(),
  size_per_disk: z.number().optional().describe('Bytes per disk'),
});
export const StorageDiskGroupSchema = z.object({
  group: z.string().describe('disk_group_name this layout targets'),
  config: z.string().describe('direct | lvm | raid0 | raid1 | raid10 | raid5 | raid6'),
  file_system: z.string().describe('ext4 | xfs'),
  mountpoint: z.string().describe('Filesystem mount point (/ for OS, /data0… for data)'),
});
export const DiskLayoutsSchema = z.object({
  node: z.string(),
  deviceId: z.string(),
  configs: z.array(StorageConfigSchema).describe('Available storage hardware groups + their capabilities'),
  default: z
    .object({
      os_disks_group: StorageDiskGroupSchema.nullable().optional().describe('Seeded default OS layout'),
      data_disks_groups: z.array(StorageDiskGroupSchema).default([]),
      cold_storage_disks_groups: z.array(StorageDiskGroupSchema).default([]),
    })
    .describe('Seeded default layout (used as the fallback when no option is selected)'),
});
export type DiskLayouts = z.infer<typeof DiskLayoutsSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type StorageDiskGroup = z.infer<typeof StorageDiskGroupSchema>;

export const DiskLayoutSelectionSchema = z.object({
  label: z.string().optional().describe('Human label shown in the timeline'),
  os: StorageDiskGroupSchema.optional().describe('OS disk group/config/filesystem (mountpoint /)'),
  data: z.array(StorageDiskGroupSchema).optional().describe('Data disk groups (mountpoints /data0…)'),
});
export type DiskLayoutSelection = z.infer<typeof DiskLayoutSelectionSchema>;

export const StepParamSpecSchema = z.object({
  key: z.string().describe('Param key set on the step'),
  label: z.string().describe('Human label for the param input'),
  kind: z.enum(['string', 'json']).describe('Input kind: a plain string or a JSON value (object/array)'),
  optional: z.boolean().describe('Whether the param may be omitted'),
});
export const StepSpecSchema = z.object({
  id: z.string().describe('Registered step id (provision, verify-os, …)'),
  label: z.string().describe('Human label shown in the builder'),
  params: z.array(StepParamSpecSchema).describe('Editable params this step accepts'),
});
export const PlanStepJsonSchema = z.object({
  step: z.string().describe('Registered step id'),
  params: z.record(z.unknown()).optional().describe('Step params (validated by the engine at run time)'),
  always: z.boolean().optional().describe('Cleanup step: runs in a finally even after an earlier step fails'),
});
export const PlanJsonSchema = z.object({
  name: z.string().describe('Plan name'),
  select: z
    .enum(['inventory', 'any'])
    .optional()
    .describe('device selector: inventory (default) requires an INVENTORY device; any accepts any seeded device'),
  steps: z.array(PlanStepJsonSchema).describe('Ordered steps the plan runs on one device'),
});
export const PlanCatalogSchema = z.object({
  steps: z.array(StepSpecSchema).describe('The assemblable step palette for the builder'),
  presets: z
    .array(z.object({ id: z.string().describe('Scenario id the preset derives from'), plan: PlanJsonSchema }))
    .describe('Ready-made plans to clone and edit'),
  fullSuite: PlanJsonSchema.describe('A comprehensive sequence covering every non-HA scenario on one node'),
});
export type StepSpec = z.infer<typeof StepSpecSchema>;
export type PlanJson = z.infer<typeof PlanJsonSchema>;
export type PlanStepJson = z.infer<typeof PlanStepJsonSchema>;
export type PlanCatalog = z.infer<typeof PlanCatalogSchema>;

export const LayerRelationSchema = z.object({
  relatedOptionValue: z.string(),
  type: z.string().describe('REQUIRES | CONFLICTS'),
  groupId: z.string().nullable().optional().describe('OR-group id for REQUIRES alternatives'),
});
export const LayerOptionSchema = z.object({
  value: z.string().describe('Layer slug'),
  label: z.string(),
  relations: z.array(LayerRelationSchema).default([]),
});
export const LayerGroupSchema = z.object({
  slug: z.string().describe('Layer-group slug (gpuDriver, gpuFramework, miscSoftware, …)'),
  name: z.string(),
  selectionType: z.enum(['SINGLE_SELECT', 'MULTI_SELECT']),
  options: z.array(LayerOptionSchema),
});
export const LayerCatalogSchema = z.object({
  node: z.string(),
  deviceId: z.string(),
  gpuModel: z.string().nullable().describe('Discovered GPU model; null = only hardware-agnostic layers eligible'),
  lifecycleStatus: z.string().nullable(),
  baseLayers: z.array(z.object({ slug: z.string(), name: z.string() })),
  componentsByBase: z.record(z.string(), z.array(LayerGroupSchema)).describe('base slug → eligible component groups'),
});
export type LayerCatalog = z.infer<typeof LayerCatalogSchema>;
export type LayerGroup = z.infer<typeof LayerGroupSchema>;
export type LayerOption = z.infer<typeof LayerOptionSchema>;
export const CustomizationsSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
export type Customizations = z.infer<typeof CustomizationsSchema>;

export const TestEventLevelSchema = z
  .enum(['info', 'warn', 'error', 'success'])
  .describe('Event severity — drives the timeline row color');
export type TestEventLevel = z.infer<typeof TestEventLevelSchema>;

export const TestEventSchema = z.object({
  id: z.number().int().describe('Monotonic event id within the run'),
  runId: z.string().describe('Run this event belongs to'),
  timestamp: z.number().describe('Unix ms'),
  source: z
    .string()
    .describe('Event source — an open producer set; known producers: test, ssh, db, atom, bmc, saga, api'),
  level: TestEventLevelSchema,
  message: z.string().describe('Human-readable event text'),
  metadata: z.record(z.string(), z.unknown()).nullable().optional().describe('Structured context (e.g. deviceId)'),
});
export type TestEvent = z.infer<typeof TestEventSchema>;

export const PostTestEventSchema = z.object({
  source: z.string().default('test').describe('Producer posting the event (test, ssh, db, atom, bmc, saga, api, …)'),
  level: TestEventLevelSchema.default('info'),
  message: z.string().describe('Human-readable event text'),
  metadata: z.record(z.string(), z.unknown()).nullable().optional().describe('Structured context (e.g. deviceId)'),
});
export type PostTestEvent = z.infer<typeof PostTestEventSchema>;

export const TestResultAttachmentSchema = z.object({
  name: z.string().describe('Human label shown in the results UI (e.g. "hub-api", "test output")'),
  source: z.string().describe('File name inside the run results dir, passed to the attachment download route'),
  type: z.string().describe('MIME type of the attachment content (text/plain for log slices)'),
});
export type TestResultAttachment = z.infer<typeof TestResultAttachmentSchema>;

export const ResultStatusSchema = z
  .enum(['passed', 'failed', 'broken', 'skipped', 'unknown'])
  .describe('Outcome of a test case or step');
export type ResultStatus = z.infer<typeof ResultStatusSchema>;

export interface TestResultStep {
  name: string;
  status: ResultStatus;
  durationMs: number | null;
  steps: TestResultStep[];
  attachments: TestResultAttachment[];
}
export const TestResultStepSchema: z.ZodType<TestResultStep> = z
  .lazy(() =>
    z.object({
      name: z.string().describe('Step name'),
      status: ResultStatusSchema,
      durationMs: z.number().nullable().describe('Step duration in ms (null when not recorded)'),
      steps: z.array(TestResultStepSchema).describe('Nested sub-steps'),
      attachments: z.array(TestResultAttachmentSchema).describe('Attachments captured by this step'),
    }),
  )
  .describe('One recorded step of a test case; steps nest recursively');

export const TestResultCaseSchema = z.object({
  name: z.string().describe('Test case name'),
  status: ResultStatusSchema,
  durationMs: z.number().nullable().describe('Case duration in ms (null when not recorded)'),
  message: z.string().nullable().describe('Failure message (null when the case did not fail)'),
  trace: z.string().nullable().describe('Failure stack trace (null when the case did not fail)'),
  steps: z.array(TestResultStepSchema).describe('Recorded steps of the case'),
  attachments: z.array(TestResultAttachmentSchema).describe('Attachments captured at the case level'),
});
export type TestResultCase = z.infer<typeof TestResultCaseSchema>;

export const TestResultSchema = z.object({
  runId: z.string().describe('Run this result belongs to'),
  summary: z
    .object({
      total: z.number().int().describe('Total test cases'),
      passed: z.number().int().describe('Passed cases'),
      failed: z.number().int().describe('Failed cases (assertion failures)'),
      broken: z.number().int().describe('Broken cases (unexpected errors)'),
      skipped: z.number().int().describe('Skipped cases'),
      unknown: z.number().int().describe('Cases with an unrecognized status'),
    })
    .describe('Per-status case counts'),
  tests: z.array(TestResultCaseSchema).describe('Parsed test cases (empty until the structured vitest reporter lands)'),
  runLogs: z.array(TestResultAttachmentSchema).describe('Captured per-run service log slices (hub/spoke/test output)'),
});
export type TestResult = z.infer<typeof TestResultSchema>;
