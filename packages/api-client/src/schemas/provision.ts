import { z } from 'zod';
import { OperatingSystemSlugSchema } from './common';

export const CLOUD_INIT_MAX_BYTES = 65_536;

// Enum (not free string) so an operator-supplied `format` never reaches the LUKS shell templates as an arbitrary token; the agent only has mkfs.ext4/mkfs.xfs.
export const SUPPORTED_DISK_FORMATS = ['ext4', 'xfs'] as const;

export const MOUNTPOINT_PATTERN = /^\/[A-Za-z0-9._/-]*$/;

// Must stay in lockstep with ProvisionValidatorService.validateMountpoint: safe charset, 1-2 slashes, no empty segments (the regex alone is weaker than the server).
export function isValidMountpoint(mountpoint: string): boolean {
  if (!MOUNTPOINT_PATTERN.test(mountpoint)) return false;
  const slashCount = (mountpoint.match(/\//g) ?? []).length;
  if (slashCount < 1 || slashCount > 2) return false;
  if (mountpoint === '/') return true;
  return mountpoint
    .split('/')
    .slice(1)
    .every((segment) => segment.length > 0);
}

export const CloudInitJsonSchema = z
  .object({
    users: z
      .array(
        z.union([
          z.string(),
          z.object({
            name: z.string().describe('Username for the account'),
            gecos: z.string().optional().describe('User description / full name (GECOS field)'),
            sudo: z
              .union([z.string(), z.array(z.string()), z.boolean()])
              .optional()
              .describe('Sudo access rules for the user'),
            shell: z.string().optional().describe('Login shell path'),
            ssh_authorized_keys: z.array(z.string()).optional().describe('SSH public keys to authorize for this user'),
            lock_passwd: z.boolean().optional().describe('Whether to lock the password (disable password login)'),
            passwd: z.string().optional().describe('Hashed password for the user account'),
            groups: z
              .union([z.string(), z.array(z.string())])
              .optional()
              .describe('Groups to add the user to'),
            home: z.string().optional().describe('Home directory path'),
            system: z.boolean().optional().describe('Whether this is a system (non-login) account'),
          }),
        ]),
      )
      .optional()
      .describe('User accounts to create on the system'),

    packages: z
      .union([
        z.array(
          z.union([
            z.string(),
            z.object({
              name: z.string().describe('Package name'),
              version: z.union([z.string(), z.number()]).optional().describe('Specific package version to install'),
              state: z.string().optional().describe('Desired package state (e.g. present, latest)'),
            }),
          ]),
        ),
        z.record(z.unknown()),
        z.unknown(),
      ])
      .optional()
      .describe('Packages to install during cloud-init'),

    runcmd: z
      .array(z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe('Shell commands to run during first boot'),
    write_files: z
      .array(
        z.object({
          path: z.string().describe('Absolute file path on the target system'),
          content: z.string().describe('File content to write'),
          permissions: z.union([z.string(), z.number()]).optional().describe('File permissions (e.g. "0644" or 0o644)'),
          owner: z.union([z.string(), z.number()]).optional().describe('File owner (e.g. "root:root")'),
        }),
      )
      .optional()
      .describe('Files to create or overwrite on the target system'),
    bootcmd: z
      .array(z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe('Commands to run early in the boot process, before runcmd'),
    apt: z
      .object({
        preserve_sources_list: z.boolean().optional().describe('Whether to preserve the existing apt sources list'),
        primary: z
          .array(
            z.object({
              arches: z
                .union([z.string(), z.array(z.string())])
                .optional()
                .describe('Architectures this source applies to'),
              uri: z.string().describe('APT repository URI'),
            }),
          )
          .optional()
          .describe('Primary APT repository sources'),
      })
      .or(z.record(z.unknown()))
      .optional()
      .describe('APT package manager configuration'),
    hostname: z.string().optional().describe('System hostname to set'),
    fqdn: z.string().optional().describe('Fully qualified domain name to set'),
    chpasswd: z
      .object({
        list: z.union([z.string(), z.array(z.string())]).describe('Password entries in user:password format'),
        expire: z.boolean().optional().describe('Whether to expire passwords and force change on first login'),
      })
      .or(z.record(z.unknown()))
      .optional()
      .describe('Password change configuration'),
    locale: z
      .union([z.string(), z.record(z.unknown())])
      .optional()
      .describe('System locale setting (e.g. en_US.UTF-8)'),
    timezone: z.string().optional().describe('System timezone (e.g. America/New_York)'),
    resolv_conf: z
      .union([z.string(), z.record(z.unknown())])
      .optional()
      .describe('DNS resolver configuration'),
    disable_root: z
      .union([z.boolean(), z.record(z.unknown())])
      .optional()
      .describe('Whether to disable root SSH login'),
    swap: z
      .union([z.number(), z.boolean(), z.record(z.unknown())])
      .optional()
      .describe('Swap space configuration'),
    ntp: z
      .object({
        enabled: z.boolean().optional().describe('Whether NTP time synchronization is enabled'),
        pools: z.array(z.string()).optional().describe('NTP pool server hostnames'),
        servers: z.array(z.string()).optional().describe('NTP server hostnames'),
      })
      .or(z.record(z.unknown()))
      .optional()
      .describe('NTP time synchronization configuration'),
    ssh_config: z
      .object({
        ssh_deletekeys: z.boolean().optional().describe('Whether to delete existing SSH host keys on first boot'),
        ssh_genkeytypes: z.array(z.string()).optional().describe('SSH host key types to generate'),
        allow_public_ssh_keys: z.boolean().optional().describe('Whether to allow public SSH key authentication'),
      })
      .or(z.record(z.unknown()))
      .optional()
      .describe('SSH daemon configuration'),
  })
  .passthrough()
  .nullable()
  .optional();

export type CloudInitJson = z.infer<typeof CloudInitJsonSchema>;
export const CloudInitSchema = z
  .union([
    z.string().max(CLOUD_INIT_MAX_BYTES, 'Cloud-init payload must not exceed 64 KB'),
    z.null(),
    CloudInitJsonSchema,
  ])
  .nullable()
  .optional()
  .describe('Cloud-init configuration as YAML string (max 64 KB), JSON object, or null');
export type CloudInit = z.infer<typeof CloudInitSchema>;

export const provisionDiskLayoutSchema = z.object({
  config: z
    .string()
    .min(1)
    .describe(
      'Disk layout strategy. (e.g.: lvm, direct, raid0, raid1, raid5, raid6, raid10, raid50, raid60) "direct" partitions only a single disk, leaving all others unpartitioned.',
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
  disks: z.array(z.string().min(1)).describe('List of disk device names'),
  encrypt: z
    .boolean()
    .optional()
    .describe(
      'Enable LUKS disk encryption for this disk group (defaults to false). Not supported on system mountpoints (/, /home, /tmp, /usr, /var). Cannot encrypt when preserve (wipe=false) is enabled.',
    ),
  wipe: z
    .boolean()
    .describe(
      'Whether to wipe this disk group (required, explicit). On initial provision this must be true (there is no existing data to preserve); on reprovision set false to preserve existing data.',
    ),
});

export type DiskLayout = z.infer<typeof provisionDiskLayoutSchema>;

export const provisionCommonFields = {
  deploymentName: z.string().min(1).describe('Name for the deployment'),
  operatingSystem: OperatingSystemSlugSchema,
  sshKeyIds: z
    .array(z.string().uuid())
    .min(1, 'At least one SSH key is required')
    .describe('SSH key IDs to deploy to the device (at least one required)'),
  diskLayouts: z
    .array(provisionDiskLayoutSchema)
    .min(1, 'At least one disk layout is required')
    .describe('Disk layout configuration for provisioning'),
  cloudInit: CloudInitSchema,
  cloudInitTemplateId: z
    .string()
    .uuid()
    .optional()
    .describe('ID of a saved cloud-init template to use instead of inline cloudInit'),
  cloudInitTemplateName: z.string().max(100).optional().describe('Name for the auto-saved cloud-init template'),
} as const;

export const customizationsField = {
  customizations: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .nullable()
    .optional()
    .describe(
      'OS layer customizations keyed by layer slug (e.g. {"gpuDriver": "nvidia-driver-580", "gpuFramework": "cuda-13-1", "miscSoftware": ["docker", "ollama"]}). Null/omitted for legacy images or an un-customized base.',
    ),
} as const;

export const teeField = {
  tee: z
    .boolean()
    .optional()
    .describe(
      'Request hardware (BMC) TEE for this provision; used by iPXE Custom where there is no TEE layer to select.',
    ),
} as const;
