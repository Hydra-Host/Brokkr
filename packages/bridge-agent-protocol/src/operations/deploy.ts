import { z } from 'zod';

import { Sha256Hex } from './agent.js';
import { EncryptedVolume, TargetPath } from './storage.js';

const OsLayerUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://') || u.startsWith('http://'), {
    message: 'url must be http:// or https://',
  })
  .describe('Fully-qualified URL for an OS layer blob. Content-addressed; integrity by sha256.');

export const Architecture = z
  .enum(['amd64', 'arm64'])
  .describe("CPU architecture in curtin's naming: 'amd64' or 'arm64'.");
export type Architecture = z.infer<typeof Architecture>;

export const EncryptedVolumeConfig = EncryptedVolume;
export type EncryptedVolumeConfig = z.infer<typeof EncryptedVolume>;

export const ImageSource = z
  .object({
    url: OsLayerUrl.describe('Content-addressed URL for the base layer ({OS_LAYER_URL}/sha256:<hash>).'),
    compression: z.enum(['gzip', 'zstd']).describe('Tarball compression; selects between `tar -z` and `tar --zstd`.'),
    sha256: Sha256Hex.describe('Expected sha256 of the blob. Agent verifies post-fetch, pre-extract.'),
  })
  .describe('Base OS image descriptor; HTTPS layer tarball.');
export type ImageSource = z.infer<typeof ImageSource>;

export const Customizations = z
  .object({
    layers: z
      .array(
        z.object({
          name: z.string().describe('Customization layer name. Log-readable, not used for identity.'),
          url: OsLayerUrl.describe('Content-addressed URL for the layer ({OS_LAYER_URL}/sha256:<hash>).'),
          compression: z.enum(['gzip', 'zstd']).describe('Layer tarball compression.'),
          stack_position: z
            .number()
            .int()
            .describe('Ordering key; lower applies first. Stable across snapshots/releases.'),
          sha256: Sha256Hex.describe('Expected sha256 of the layer blob.'),
        }),
      )
      .describe('Ordered list of customization layers (bridge-sorted by stack_position).'),
  })
  .describe('Optional customization overlay set applied after the base image restore.');
export type Customizations = z.infer<typeof Customizations>;

// Plaintext http is acceptable only here — the request never leaves the box/local network (local dev + SIM).
function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const a = parseInt(m[1]!, 10);
  const b = parseInt(m[2]!, 10);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// Trust boundary for the deployment-OS bearer token: https required for public hosts (a compromised bridge must not redirect it to plain http); http only for loopback/private.
function isAllowedPhoneHomeEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopbackOrPrivateHost(url.hostname);
  return false;
}

const PhoneHomeEndpointUrl = z.string().refine(isAllowedPhoneHomeEndpoint, {
  message: 'phone-home endpoint must be an https:// URL (http:// is permitted only for loopback/private hosts)',
});

export const PhoneHomeCreds = z.object({
  endpoint: PhoneHomeEndpointUrl.describe(
    'Phone-home endpoint baked into the per-boot script. https required for public hosts; http allowed only for loopback/private hosts (local dev + SIM).',
  ),
  deployment_os_token: z.string().describe('Opaque bearer token plaintext.'),
});
export type PhoneHomeCreds = z.infer<typeof PhoneHomeCreds>;

export const CloudInitVars = z.object({
  device_id: z
    .string()
    .describe("Bridge-side device id used as cloud-init's instance-id. String-typed for UUID forward-compat."),
  ssh_pubkeys: z.array(z.string()).describe('SSH authorized_keys for the default user.'),
  password_hash: z
    .string()
    .optional()
    .describe('crypt(3)-style password hash. When unset, the default user is locked.'),
  netplan_yaml: z.string().describe('Pre-rendered netplan YAML body. Agent writes verbatim to network-config.'),
  phone_home_creds: PhoneHomeCreds.describe('Bearer phone-home creds + endpoint.'),
  custom_user_data_yaml: z
    .string()
    .optional()
    .describe('Optional operator-supplied cloud-init override merged into user-data.'),
});
export type CloudInitVars = z.infer<typeof CloudInitVars>;

export const SerialPorts = z.object({
  port: z
    .string()
    .describe(
      "Serial port name (e.g. 'ttyS1'). Probe-confirmed when available; bridge falls back to record default otherwise.",
    ),
  baud: z.number().int().optional().describe('Baud rate to use; defaults to 115200 when omitted.'),
});
export type SerialPorts = z.infer<typeof SerialPorts>;

export const GrubVars = z.object({
  gpu_model: z
    .string()
    .optional()
    .describe('Device GPU model string; case-insensitive gh200 substring enables memhp_default_state.'),
  pci_realloc_off: z
    .boolean()
    .default(false)
    .describe('Adds pci=realloc=off to GRUB_CMDLINE_LINUX (quirky devices like xe9780).'),
  serial_ports: SerialPorts.optional().describe('Serial console configuration; omitted means no-serial branch.'),
  purge_ttys: z
    .boolean()
    .default(false)
    .describe('Runtime flag for an in-chroot sed against 50-cloudimg-settings.cfg.'),
});
export type GrubVars = z.infer<typeof GrubVars>;

export const RoceVars = z.object({
  enabled: z.boolean().describe('Whether the device is configured for RoCE east-west networking.'),
  doca_repo_url: z.string().describe('Bridge-resolved Mellanox DOCA APT repo URL. Empty when enabled=false.'),
});
export type RoceVars = z.infer<typeof RoceVars>;

export const mountChroot = {
  input: z.object({
    target_path: TargetPath.default('/target').describe('Directory hosting the mounted chroot. Must already exist.'),
  }),
  output: z.object({
    mounted_points: z.array(z.string()).describe('Full paths of bind-mounts that were successfully established.'),
  }),
} as const;

export const unmountChroot = {
  input: z.object({
    target_path: TargetPath.default('/target').describe('Target path whose chroot bind-mounts should be torn down.'),
  }),
  output: z.object({
    unmounted: z.array(z.string()).describe('Full paths that were successfully unmounted.'),
  }),
} as const;

export const restoreHttpsLayer = {
  input: z.object({
    target_path: TargetPath.default('/target').describe('Extraction destination (chroot root).'),
    url: OsLayerUrl.describe('Content-addressed URL for the tarball ({OS_LAYER_URL}/sha256:<hash>).'),
    compression: z.enum(['gzip', 'zstd']).describe('Tarball compression; picks between `tar -z` and `tar --zstd`.'),
    sha256: Sha256Hex.describe('Expected sha256 of the blob. Agent verifies post-fetch, pre-extract; mismatch aborts.'),
  }),
  output: z.object({
    bytes: z.number().int().nonnegative().describe('Bytes transferred from the network fetch.'),
  }),
} as const;

export const removeWhiteouts = {
  input: z.object({
    target_path: TargetPath.default('/target').describe('Filesystem tree to scan for overlay whiteout nodes.'),
  }),
  output: z.object({
    removed: z.number().int().nonnegative().describe('Count of whiteout character-device entries removed.'),
  }),
} as const;

export const configureMdadm = {
  input: z.object({
    target_path: TargetPath.default('/target'),
    hostname: z.string().describe('Hostname to substitute for the brokkr-discovery placeholder in mdadm.conf.'),
  }),
  output: z.object({
    configured: z.boolean().describe('True iff any arrays were detected and /etc/mdadm/mdadm.conf was written.'),
  }),
} as const;

export const writeFstab = {
  input: z.object({
    target_path: TargetPath.default('/target'),
    content: z.string().describe('Full /etc/fstab body, rendered on the bridge.'),
  }),
  output: z.object({
    success: z.boolean().describe('Always true on success; the operation throws on write failure.'),
  }),
} as const;

export const writeCrypttab = {
  input: z.object({
    target_path: TargetPath.default('/target'),
    content: z
      .string()
      .describe('Full /etc/crypttab body; empty/whitespace content is a no-op (matches Python behavior).'),
  }),
  output: z.object({
    success: z.boolean().describe('True iff the write path was taken or a no-op was elected.'),
  }),
} as const;

// Security: input carries validated parameters, never script bodies — the agent owns the luks-{rekey,unlock,lock} templates, so a compromised bridge cannot plant executable code in the LUKS path.
export const installLuksScripts = {
  input: z.object({
    target_path: TargetPath.default('/target'),
    encrypted_volumes: z
      .array(EncryptedVolume)
      .describe(
        'ALL encrypted volumes (new + preserved). The agent renders luks-unlock/luks-lock over this full ' +
          'set so every container can be opened/closed.',
      ),
    rekey_volumes: z
      .array(EncryptedVolume)
      .default([])
      .describe(
        'Volumes the luks-rekey script is allowed to luksFormat — newly-provisioned volumes ONLY. ' +
          'Preserved volumes MUST NOT appear here: rekey reformats every device it lists, which would ' +
          'destroy preserved data. Defaults to empty (rekey targets nothing).',
      ),
    already_keyed: z
      .boolean()
      .default(false)
      .describe('When true, the rendered rekey script refuses to run (guards against reformatting keyed volumes).'),
  }),
  output: z.object({
    installed: z.array(z.string()).describe('Full paths of the installed scripts.'),
  }),
} as const;

export const installGrub = {
  input: z.object({
    target_path: TargetPath.default('/target'),
    arch: Architecture.describe('Target architecture; selects the GRUB target string.'),
    uefi: z.boolean().describe('True for UEFI install path, false for Legacy BIOS per-disk install.'),
    distro: z.string().describe("Bootloader-id used by UEFI grub-install (e.g. 'Ubuntu')."),
    grub_disks: z.array(z.string()).describe('Legacy BIOS per-disk targets. Unused when uefi=true.'),
    grub_defaults: z.string().describe('Rendered /etc/default/grub body.'),
    grub_fallback_cfg: z
      .string()
      .optional()
      .describe('grub-mkstandalone input for the UEFI fallback loader. Used only when uefi=true.'),
    purge_ttys: z
      .boolean()
      .default(false)
      .describe('When true, sed-in-chroot removes ttyS console args from 50-cloudimg-settings.cfg.'),
  }),
  output: z.object({
    installed_targets: z
      .array(z.string())
      .describe("Successfully-installed GRUB targets, e.g. ['x86_64-efi'] or ['i386-pc:/dev/sda', ...]."),
  }),
} as const;

export const finalizeEfi = {
  input: z.object({
    target_path: TargetPath.default('/target'),
    uefi: z.boolean().describe('When false, the op is a fast no-op.'),
  }),
  output: z.object({
    skipped: z.boolean().describe('True iff uefi=false and the op returned without touching anything.'),
    cleaned: z.array(z.string()).describe('Paths of removed /boot/efiN directories.'),
  }),
} as const;

// Security: phone-home script/creds bodies are never accepted from the bridge — the agent renders them from validated parameters.
const EXTRA_FILE_MODE_ALLOWLIST = [0o644, 0o755, 0o600] as const;
const MAX_EXTRA_FILES = 32;
const MAX_EXTRA_FILE_BYTES = 256 * 1024;
const MAX_EXTRA_FILES_TOTAL_BYTES = 1024 * 1024;

// Agent-owned artifacts extra_files may never shadow (mirrors agent-side enforcement in cloudinit.ts).
const RESERVED_CORE_PATHS = [
  'etc/cloud/cloud.cfg',
  'var/lib/cloud/seed/nocloud/meta-data',
  'var/lib/cloud/seed/nocloud/user-data',
  'var/lib/cloud/seed/nocloud/network-config',
  'var/lib/brokkr/phone-home-creds.json',
  'var/lib/cloud/scripts/per-boot/90-phone-home.sh',
] as const;
const RESERVED_PATH_PREFIXES = ['var/lib/cloud/scripts/'] as const;
const normalizeRel = (p: string): string => p.replace(/\/+/g, '/').replace(/\/+$/, '');

export const writeCloudInitFiles = {
  input: z
    .object({
      target_path: TargetPath.default('/target'),
      cloud_cfg: z.string().describe('Rendered /etc/cloud/cloud.cfg content.'),
      meta_data: z.string().describe('Rendered seed meta-data content.'),
      user_data: z.string().describe('Rendered seed user-data content.'),
      network_config: z.string().describe('Rendered seed network-config content.'),
      device_id: z.string().describe('Device id; rendered into the agent-owned phone-home creds sidecar.'),
      phone_home_creds: PhoneHomeCreds.describe(
        'Validated endpoint + bearer token. The agent renders both the per-boot script and the creds ' +
          'JSON from its own templates; no script/creds body is accepted from the bridge.',
      ),
      extra_files: z
        .array(
          z.object({
            path: z
              .string()
              .refine((p) => !p.startsWith('/'), { message: 'must be relative (no leading /)' })
              .refine((p) => p.split('/').every((s) => s !== '.' && s !== '..'), {
                message: "must not contain '.' or '..' path segments",
              })
              // eslint-disable-next-line no-control-regex -- intentional: reject control bytes in wire path
              .refine((p) => !/[\x00-\x1f]/.test(p), { message: 'must not contain control characters' })
              .refine(
                (p) => {
                  const rel = normalizeRel(p);
                  return (
                    !(RESERVED_CORE_PATHS as readonly string[]).includes(rel) &&
                    !RESERVED_PATH_PREFIXES.some((pre) => rel.startsWith(pre))
                  );
                },
                { message: 'must not collide with a reserved agent-owned path' },
              )
              .describe('Path relative to target_path (no leading /, no . or .. segments).'),
            content: z.string().refine((c) => Buffer.byteLength(c, 'utf8') <= MAX_EXTRA_FILE_BYTES, {
              message: `content exceeds per-file cap of ${MAX_EXTRA_FILE_BYTES} bytes`,
            }),
            mode: z
              .number()
              .int()
              .refine((m) => (EXTRA_FILE_MODE_ALLOWLIST as readonly number[]).includes(m), {
                message: 'mode must be one of 0o644, 0o755, 0o600',
              }),
          }),
        )
        .max(MAX_EXTRA_FILES, { message: `at most ${MAX_EXTRA_FILES} extra_files allowed` })
        .default([])
        .describe(
          'Additional cloud-init artifacts the renderer emits beyond the required core (e.g. cloud.cfg.d/*.cfg). ' +
            'Bounded by count + per-entry/total size; each mode is restricted to 0o644/0o755/0o600.',
        ),
    })
    .refine(
      (v) =>
        v.extra_files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0) <= MAX_EXTRA_FILES_TOTAL_BYTES,
      { message: `extra_files total content exceeds ${MAX_EXTRA_FILES_TOTAL_BYTES} bytes`, path: ['extra_files'] },
    )
    .refine(
      (v) => {
        const rels = v.extra_files.map((f) => normalizeRel(f.path));
        return new Set(rels).size === rels.length;
      },
      { message: 'extra_files contains duplicate paths', path: ['extra_files'] },
    ),
  output: z.object({
    written: z.array(z.string()).describe('Full paths of all files written (required core + any extras).'),
  }),
} as const;

export const applyRoceChrootConfig = {
  input: z.object({
    target_path: TargetPath.default('/target'),
  }),
  output: z.object({
    success: z
      .boolean()
      .describe('True iff the edit path completed (or was a no-op because the target file was absent).'),
  }),
} as const;

export const powerCycleCleanup = {
  input: z.object({
    target_path: TargetPath.default('/target'),
  }),
  output: z.object({
    success: z
      .boolean()
      .describe('Always true — every sub-step is best-effort; individual failures are logged and swallowed.'),
  }),
} as const;

export const deployOS = {
  input: z.object({
    target_path: TargetPath.default('/target').describe('Chroot root for the entire pipeline.'),
    arch: Architecture.describe('Target architecture.'),
    uefi: z.boolean().describe('UEFI vs Legacy BIOS selection; affects installGrub and finalizeEfi.'),
    distro: z.string().describe('Distro name; used in GRUB bootloader-id and related config.'),
    hostname: z.string().describe('Hostname for mdadm and downstream cloud-init.'),
    grub_disks: z.array(z.string()).describe('Legacy BIOS per-disk GRUB install targets (empty when uefi=true).'),

    image: ImageSource.describe('Base OS image source (HTTPS layer tarball).'),
    customizations: Customizations.optional().describe(
      'Optional overlay customizations applied after the base restore.',
    ),

    fstab: z.string().describe('Rendered /etc/fstab body.'),
    crypttab: z.string().optional().describe('Rendered /etc/crypttab body; omit when there are no encrypted volumes.'),
    encrypted_volumes: z
      .array(EncryptedVolumeConfig)
      .default([])
      .describe(
        'ALL encrypted volumes (new + preserved) for unlock/lock script targeting. Empty when the device has no LUKS.',
      ),
    rekey_volumes: z
      .array(EncryptedVolumeConfig)
      .default([])
      .describe(
        'Newly-provisioned encrypted volumes the rekey script may luksFormat. Preserved volumes are excluded ' +
          'so a mixed new+preserved layout never reformats preserved data.',
      ),

    roce_iommu: z
      .boolean()
      .default(false)
      .describe(
        'When true, applyRoceChrootConfig is run for nvidia-persistenced compatibility on RoCE east-west devices.',
      ),
    cloud_init_vars: CloudInitVars.describe('Cloud-init renderer inputs.'),
    grub_vars: GrubVars.describe('GRUB renderer inputs.'),
    luks_already_keyed: z
      .boolean()
      .default(false)
      .describe('When true, the rekey script skips the initial luksAddKey call.'),
    roce: RoceVars.describe('RoCE east-west fabric configuration (typed-vars cutover).'),
  }),
  output: z.object({
    deployed: z.literal(true).describe('Always true — the op throws rather than returning deployed=false.'),
  }),
} as const;

export const operations = {
  mountChroot,
  unmountChroot,
  restoreHttpsLayer,
  removeWhiteouts,
  configureMdadm,
  writeFstab,
  writeCrypttab,
  installLuksScripts,
  installGrub,
  finalizeEfi,
  writeCloudInitFiles,
  applyRoceChrootConfig,
  powerCycleCleanup,
  deployOS,
} as const;
