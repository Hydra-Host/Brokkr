import { InterruptibleClaimStatus } from '@repo/database/enums';
import { z } from 'zod';
import { DeviceDiagnosticsTypeSchema } from './bmc';
import { IpxeBootUrlSchema } from './common';
import { availableLayersFields } from './customizations';
import { LifecycleRequestResponseSchema } from './lifecycle-requests';
import { zodEnumFromPrisma } from './prisma-enum';
import {
  customizationsField,
  isValidMountpoint,
  provisionCommonFields,
  SUPPORTED_DISK_FORMATS,
  teeField,
} from './provision';
import { SshKeyWithUserSchema } from './sshkeys';

const statusSchema = z.object({
  value: z.string().describe('Machine-readable status identifier'),
  label: z.string().describe('Human-readable status label'),
});

const roleSchema = z.object({
  slug: z.string().describe('Machine-readable role identifier'),
});

const deviceTagSchema = z.object({
  slug: z.string().describe('Machine-readable tag identifier'),
});

const deploymentCustomerSchema = z.object({
  deviceName: z.string().describe('Customer-assigned name for the device'),
  organizationId: z.string().describe('Organization that owns this deployment'),
  provisionedDate: z.string().describe('ISO 8601 date when the device was provisioned'),
  sshPubKeys: z.string().describe('Concatenated SSH public keys deployed to the device'),
  sshPubKeysIds: z.string().describe('Comma-separated IDs of SSH keys deployed to the device'),
  userId: z.string().describe('User who provisioned the deployment'),
});

const deploymentNetworkingSchema = z.object({
  ipv4: z.string().nullable().optional().describe('Primary IPv4 address'),
  ipv6: z.string().nullable().optional().describe('Primary IPv6 address'),
  mac: z.string().nullable().optional().describe('MAC address of the primary network interface'),
});

const deploymentCpuSchema = z.object({
  coresPerCpu: z.number().describe('Number of physical cores per CPU socket'),
  count: z.number().describe('Number of CPU sockets'),
  model: z.string().describe('CPU model name'),
  threadsPerCore: z.number().describe('Number of threads per physical core'),
  threadsPerCpu: z.number().describe('Number of threads per CPU socket'),
  totalCores: z.number().describe('Total physical cores across all sockets'),
  totalThreads: z.number().describe('Total threads across all sockets'),
});

const deploymentGpuSchema = z.object({
  count: z.number().describe('Number of GPUs installed'),
  model: z.string().describe('GPU model name'),
});

const deploymentMemorySchema = z.object({
  total: z.number().describe('Total memory in GB'),
});

const deploymentStorageSchema = z.object({
  hddCount: z.number().describe('Number of HDD drives'),
  hddSize: z.number().describe('Total HDD storage in bytes'),
  nvmeCount: z.number().describe('Number of NVMe drives'),
  nvmeSize: z.number().describe('Total NVMe storage in bytes'),
  ssdCount: z.number().describe('Number of SSD drives'),
  ssdSize: z.number().describe('Total SSD storage in bytes'),
  total: z.number().describe('Total storage capacity in bytes'),
});

const deploymentSpecsSchema = z.object({
  operating_system: z.string().optional().nullable().describe('Currently installed operating system name'),
  current_rescue_operating_system_name: z
    .string()
    .optional()
    .nullable()
    .describe('Active rescue OS name if in rescue mode'),
  cpu: deploymentCpuSchema.describe('CPU hardware specifications'),
  gpu: deploymentGpuSchema.describe('GPU hardware specifications'),
  memory: deploymentMemorySchema.describe('Memory specifications'),
  storage: deploymentStorageSchema.describe('Storage hardware specifications'),
});

const diskSchema = z.object({
  wwn: z.string().optional().nullable().describe('World Wide Name identifier for the disk'),
  name: z.string().describe('Device name (e.g. /dev/sda)'),
  serial: z.string().optional().nullable().describe('Disk serial number'),
});

const storageLayoutConfigSchema = z.object({
  disks: z.array(diskSchema).describe('Physical disks in this storage group'),
  disk_type: z.string().describe('Type of disk (e.g. NVMe, SSD, HDD)'),
  capabilities: z.array(z.string()).describe('Supported RAID or filesystem capabilities'),
  num_disks: z.number().describe('Number of disks in this group'),
  size_per_disk: z.number().describe('Storage capacity per disk in bytes'),
  disk_group_name: z.string().describe('Identifier for this disk group'),
  file_systems: z.array(z.string()).optional().describe('Supported filesystem types'),
});

const storageLayoutDiskGroupSchema = z.object({
  config: z.string().describe('RAID configuration (e.g. RAID1, JBOD)'),
  file_system: z.string().describe('Filesystem type (e.g. ext4, xfs)'),
  group: z.string().describe('Disk group this layout applies to'),
  mountpoint: z.string().describe('Filesystem mount point'),
});

const storageLayoutsSchema = z.object({
  configs: z.array(storageLayoutConfigSchema).describe('Available storage hardware configurations'),
  default: z.object({
    os_disks_group: storageLayoutDiskGroupSchema.optional().nullable().describe('Default layout for OS disks'),
    data_disks_groups: z
      .array(storageLayoutDiskGroupSchema)
      .optional()
      .nullable()
      .describe('Default layout for data disk groups'),
    cold_storage_disks_groups: z
      .array(storageLayoutDiskGroupSchema)
      .optional()
      .nullable()
      .describe('Default layout for cold storage disk groups'),
  }),
});

const defaultDiskLayoutsSchema = z.array(
  z.object({
    config: z.string().describe('RAID configuration (e.g. RAID1, JBOD)'),
    format: z.string().describe('Filesystem format (e.g. ext4, xfs)'),
    mountpoint: z.string().describe('Filesystem mount point'),
    diskType: z.string().describe('Type of disk (e.g. NVMe, SSD, HDD)'),
    disks: z.array(z.string()).describe('List of disk device names'),
  }),
);

const deploymentLifecycleActionSchema = z.object({
  id: z.string().describe('Unique identifier for the lifecycle action'),
  actionType: z.string().describe('Type of action performed (e.g. provision, reboot, deprovision)'),
  performedByName: z.string().describe('Name of the user who performed the action'),
  performedByEmail: z.string().describe('Email of the user who performed the action'),
  performedAt: z.string().describe('ISO 8601 timestamp when the action was performed'),
  source: z.string().describe('Origin of the action (e.g. user, system, api)'),
});

const deploymentProjectSchema = z.object({
  id: z.string().describe('Unique identifier for the project'),
  name: z.string().describe('Project name'),
  createdAt: z.string().describe('ISO 8601 timestamp when the project was created'),
  updatedAt: z.string().nullable().describe('ISO 8601 timestamp of the last update, or null'),
  isDefault: z.boolean().describe('Whether this is the default project for the organization'),
});

const deploymentDeviceDiagnosticsSchema = z.object({
  id: z.string().uuid().describe('Unique identifier for the diagnostics record'),
  type: DeviceDiagnosticsTypeSchema.describe('Category of diagnostics collected'),
  data: z.record(z.string(), z.unknown()).nullable().describe('Diagnostics payload data'),
  createdAt: z.string().describe('ISO 8601 timestamp when the diagnostics were collected'),
});

export const DeploymentSchema = z.object({
  id: z.string().describe('Unique identifier for the deployment'),
  deviceId: z.string().describe('Identifier of the device this deployment runs on'),
  location: z.string().describe('Data center or region where the device is located'),
  status: statusSchema.describe('Current deployment lifecycle status'),
  powerStatus: statusSchema.describe('Current power state of the device'),
  scheduledInterruptionTime: z
    .string()
    .optional()
    .nullable()
    .describe('ISO 8601 timestamp of next scheduled interruption'),
  tags: z.array(deviceTagSchema).optional().nullable().describe('Tags applied to this device'),
  role: roleSchema.describe('Device role classification'),
  customer: deploymentCustomerSchema.describe('Customer and provisioning details'),
  networking: deploymentNetworkingSchema.describe('Network interface configuration'),
  specs: deploymentSpecsSchema.describe('Hardware and OS specifications'),
  sshKeys: z.array(SshKeyWithUserSchema).describe('SSH keys deployed to this device'),
  ...availableLayersFields,
  storageLayouts: storageLayoutsSchema.describe('Storage hardware layout and configuration options'),
  defaultDiskLayouts: defaultDiskLayoutsSchema.describe('Pre-configured default disk layouts'),
  isLocked: z.boolean().describe('Whether destructive actions are locked for this deployment'),
  isTeeCapable: z.boolean().describe('Whether the device supports Trusted Execution Environment'),
  teeEnabled: z.boolean().describe('Whether BMC TEE is currently enabled on this device'),
  lifecycleActions: z
    .array(deploymentLifecycleActionSchema)
    .describe('Audit log of lifecycle actions performed on this deployment'),
  lifecycleRequests: z
    .array(LifecycleRequestResponseSchema)
    .describe('Admin lifecycle requests (pending approvals, history) for this deployment'),
  project: deploymentProjectSchema.describe('Project this deployment belongs to'),
  deviceDiagnostics: z
    .array(deploymentDeviceDiagnosticsSchema)
    .describe('Device diagnostics records for this deployment'),
});

export type Deployment = z.infer<typeof DeploymentSchema>;

export const UpdateDeploymentRequestSchema = z.object({
  name: z.string().describe('New display name for the deployment'),
});

export type UpdateDeploymentRequest = z.infer<typeof UpdateDeploymentRequestSchema>;

export const DeploymentActionResponseSchema = z.object({
  success: z.boolean().describe('Whether the action completed successfully'),
  error_code: z.string().optional().nullable().describe('Machine-readable error code if the action failed'),
  message: z.string().optional().nullable().describe('Human-readable result or error message'),
  jobId: z
    .string()
    .uuid()
    .optional()
    .describe('Identifier of the lifecycle job created by this action; correlate it with the job history endpoint'),
});

export type DeploymentActionResponse = z.infer<typeof DeploymentActionResponseSchema>;

export const RescueModeActionResponseSchema = z.object({
  success: z.boolean().describe('Whether the action completed successfully'),
  message: z.string().optional().nullable().describe('Human-readable result or error message'),
  planId: z
    .string()
    .uuid()
    .describe(
      'Bridge power-plan identifier for the rescue reboot; correlate it with bridge logs. This is not a lifecycle job and will never appear in the job history endpoint',
    ),
});

export type RescueModeActionResponse = z.infer<typeof RescueModeActionResponseSchema>;

export const ExportLogsJobTypeSchema = z
  .enum(['Provision', 'Reprovision', 'Deprovision'])
  .describe('Type of provisioning job to export logs for');

export type ExportLogsJobType = z.infer<typeof ExportLogsJobTypeSchema>;

export const GetLogsRequestSchema = z.object({
  jobType: ExportLogsJobTypeSchema.describe('Type of provisioning job to retrieve logs for'),
});

export type GetLogsRequest = z.infer<typeof GetLogsRequestSchema>;

export const SolLogEntrySchema = z.object({
  timestamp: z.string().describe('ISO 8601 timestamp recorded by the bridge when this line was captured'),
  message: z
    .string()
    .describe(
      'A single line of SOL console output, or the literal "END LOG COLLECTION" sentinel that marks the end of the stream',
    ),
});

export type SolLogEntry = z.infer<typeof SolLogEntrySchema>;

export const SolLogsResponseSchema = z.object({
  success: z.boolean().describe('Whether logs were retrieved successfully'),
  message: z.string().describe('Status message or error details'),
  entries: z.array(SolLogEntrySchema).describe('SOL log entries in chronological order'),
  complete: z
    .boolean()
    .describe('True if the END LOG COLLECTION sentinel is present, indicating the bridge has finished streaming'),
});

export type SolLogsResponse = z.infer<typeof SolLogsResponseSchema>;

export const InterruptibleClaimStatusSchema = zodEnumFromPrisma(InterruptibleClaimStatus).describe(
  'Current status of the interruption claim',
);
export type { InterruptibleClaimStatus };

export const InterruptibleClaimSchema = z.object({
  id: z.string().uuid().describe('Unique identifier for the interruption claim'),
  deploymentName: z.string().describe('Name of the deployment being interrupted'),
  status: InterruptibleClaimStatusSchema.describe('Current status of the interruption claim'),
  interruptAt: z.string().describe('ISO 8601 timestamp when the interruption is scheduled'),
  deviceId: z.string().describe('Device ID associated with this claim'),
});

export type InterruptibleClaim = z.infer<typeof InterruptibleClaimSchema>;

export const ReprovisionDiskLayoutSchema = z.object({
  config: z
    .string()
    .min(1)
    .describe(
      'Disk layout strategy. (e.g. lvm, direct, raid0, raid1, raid5, raid6, raid10, raid50, raid60. "direct" partitions only a single disk, leaving others unpartitioned.)',
    ),
  format: z
    .enum(SUPPORTED_DISK_FORMATS)
    .describe('Filesystem format. One of: ext4, xfs (the only formats the deploy pipeline can create).'),
  mountpoint: z
    .string()
    .min(1)
    .refine(isValidMountpoint, {
      message:
        'Mountpoint must be an absolute path with up to two "/", no empty segments, and only letters, digits, ".", "_", "-", and "/"',
    })
    .describe('Filesystem mount point (absolute path; no shell metacharacters or whitespace)'),
  diskType: z.string().min(1).describe('Type of disk (e.g. NVMe, SSD, HDD)'),
  disks: z.array(z.string().min(1)).describe('List of disk device names to include'),
  size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Requested usable size in bytes for this disk group's filesystem (binary units). Omit for the full disk. RAID/LVM groups derive per-disk partition sizes from this value; must be at least 8 GiB for the root group and 1 GiB for other groups, must not exceed the group's usable capacity, and cannot be combined with encrypt or with wipe=false.",
    ),
  wipe: z
    .boolean()
    .describe(
      'Whether to wipe the disk before formatting (required, explicit). Set to false to preserve existing data.',
    ),
  encrypt: z
    .boolean()
    .optional()
    .describe(
      'Enable LUKS disk encryption for this disk group. Not supported on system mountpoints or when wipe is false.',
    ),
});

export const ReprovisionDeploymentRequestSchema = z.object({
  ...provisionCommonFields,
  ...customizationsField,
  ...teeField,
  diskLayouts: z
    .array(ReprovisionDiskLayoutSchema)
    .min(1, 'At least one disk layout is required')
    .describe('Disk layout configuration for reprovisioning'),
  ipxeUrl: IpxeBootUrlSchema.nullable().optional(),
});
export type ReprovisionDeploymentRequest = z.infer<typeof ReprovisionDeploymentRequestSchema>;
export type ReprovisionDiskLayout = z.infer<typeof ReprovisionDiskLayoutSchema>;

export const RebootDeploymentRequestSchema = z.object({});
export type RebootDeploymentRequest = z.infer<typeof RebootDeploymentRequestSchema>;

export const PowerCycleDeploymentRequestSchema = z.object({});
export type PowerCycleDeploymentRequest = z.infer<typeof PowerCycleDeploymentRequestSchema>;

export const PowerControlDeploymentRequestSchema = z.object({
  operation: z.enum(['on', 'off']).describe('Power operation to perform on the device'),
});
export type PowerControlDeploymentRequest = z.infer<typeof PowerControlDeploymentRequestSchema>;
