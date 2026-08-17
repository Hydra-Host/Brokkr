import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { load as parseYaml } from 'js-yaml';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import {
  CLOUD_INIT_FILE_MODES,
  renderPhoneHomeCredsJson,
  renderPhoneHomeScript,
  type PhoneHomeCredsInput,
} from '../../render/cloudinit';
import { assertTargetPathSafe } from './targetPath';

const EXTRA_FILE_MODE_ALLOWLIST: readonly number[] = [0o644, 0o755, 0o600];
const MAX_EXTRA_FILES = 32;
const MAX_EXTRA_FILE_BYTES = 256 * 1024;
const MAX_EXTRA_FILES_TOTAL_BYTES = 1024 * 1024;

// extra_files may never collide with these or the per-boot exec dir — else a bridge could plant root-run content.
const RESERVED_CORE_PATHS: readonly string[] = [
  'etc/cloud/cloud.cfg',
  'var/lib/cloud/seed/nocloud/meta-data',
  'var/lib/cloud/seed/nocloud/user-data',
  'var/lib/cloud/seed/nocloud/network-config',
  'var/lib/brokkr/phone-home-creds.json',
  'var/lib/cloud/scripts/per-boot/90-phone-home.sh',
];
const RESERVED_PATH_PREFIXES: readonly string[] = ['var/lib/cloud/scripts/'];

function normalizeRel(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/+$/, '');
}

interface CloudInitInputs {
  cloud_cfg: string;
  meta_data: string;
  user_data: string;
  network_config: string;
  device_id: string;
  phone_home_creds: PhoneHomeCredsInput;
}

interface FileSpec {
  path: string;
  content: string;
  mode: number;
}

// SEC-deploy: phone-home script + creds are rendered from agent-owned templates, never written verbatim from a bridge body — a compromised bridge can't plant per-boot executables.
function buildFileSpecs(inputs: CloudInitInputs): FileSpec[] {
  return [
    { path: 'etc/cloud/cloud.cfg', content: inputs.cloud_cfg, mode: CLOUD_INIT_FILE_MODES.cloudCfg },
    { path: 'var/lib/cloud/seed/nocloud/meta-data', content: inputs.meta_data, mode: CLOUD_INIT_FILE_MODES.metaData },
    { path: 'var/lib/cloud/seed/nocloud/user-data', content: inputs.user_data, mode: CLOUD_INIT_FILE_MODES.userData },
    {
      path: 'var/lib/cloud/seed/nocloud/network-config',
      content: inputs.network_config,
      mode: CLOUD_INIT_FILE_MODES.networkConfig,
    },
    {
      path: 'var/lib/brokkr/phone-home-creds.json',
      content: renderPhoneHomeCredsJson({ deviceId: inputs.device_id, phoneHomeCreds: inputs.phone_home_creds }),
      mode: CLOUD_INIT_FILE_MODES.phoneHomeCreds,
    },
    {
      // Binds the deployment-OS bearer token — must stay root-only (0o700), never world-readable.
      path: 'var/lib/cloud/scripts/per-boot/90-phone-home.sh',
      content: renderPhoneHomeScript({ phoneHomeCreds: inputs.phone_home_creds }),
      mode: CLOUD_INIT_FILE_MODES.phoneHomeScript,
    },
  ];
}

function assertExtraFilesBounded(extraFiles: readonly FileSpec[]): void {
  if (extraFiles.length > MAX_EXTRA_FILES) {
    throw new Error(`extra_files exceeds count cap of ${MAX_EXTRA_FILES}`);
  }
  let total = 0;
  const seen = new Set<string>();
  for (const f of extraFiles) {
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_EXTRA_FILE_BYTES) {
      throw new Error(`extra_files entry ${f.path} exceeds per-file cap of ${MAX_EXTRA_FILE_BYTES} bytes`);
    }
    if (!EXTRA_FILE_MODE_ALLOWLIST.includes(f.mode)) {
      throw new Error(`extra_files entry ${f.path} has disallowed mode ${f.mode.toString(8)} (allow: 0644/0755/0600)`);
    }
    if (f.path.startsWith('/')) {
      throw new Error(`extra_files entry ${f.path} must be relative (no leading /)`);
    }
    if (f.path.split('/').some((s) => s === '.' || s === '..')) {
      throw new Error(`extra_files entry ${f.path} must not contain '.' or '..' path segments`);
    }
    // eslint-disable-next-line no-control-regex -- intentional: reject control bytes in extra_files path
    if (/[\x00-\x1f]/.test(f.path)) {
      throw new Error(`extra_files entry ${f.path} must not contain control characters`);
    }
    const rel = normalizeRel(f.path);
    if (RESERVED_CORE_PATHS.includes(rel) || RESERVED_PATH_PREFIXES.some((pre) => rel.startsWith(pre))) {
      throw new Error(`extra_files entry ${f.path} collides with a reserved agent-owned path`);
    }
    if (seen.has(rel)) {
      throw new Error(`extra_files entry ${f.path} is a duplicate path`);
    }
    seen.add(rel);
    total += bytes;
  }
  if (total > MAX_EXTRA_FILES_TOTAL_BYTES) {
    throw new Error(`extra_files total content exceeds ${MAX_EXTRA_FILES_TOTAL_BYTES} bytes`);
  }
}

function isCloudConfigUserData(content: string): boolean {
  return /^\s*#cloud-config(\s|$)/.test(content);
}

// Malformed bridge YAML must fail loudly at write time instead of silently breaking first boot.
function assertParsesAsYaml(label: string, content: string, requireMapping: boolean): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    throw new Error(`cloud-init ${label} is not valid YAML: ${getErrorMessage(error)}`);
  }
  if (requireMapping && parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error(`cloud-init ${label} must be a YAML mapping`);
  }
}

function validateCloudInitContent(inputs: CloudInitInputs): void {
  assertParsesAsYaml('cloud.cfg', inputs.cloud_cfg, true);
  assertParsesAsYaml('meta-data', inputs.meta_data, false);
  assertParsesAsYaml('network-config', inputs.network_config, false);
  if (isCloudConfigUserData(inputs.user_data)) {
    assertParsesAsYaml('user-data', inputs.user_data, false);
  }
}

// Our instance-id is the stable device UUID, so stale NoCloud state on the rootfs would suppress first-boot modules (users/hostname/runcmd) on re-provision.
const STALE_CLOUDINIT_STATE = [
  'var/lib/cloud/data',
  'var/lib/cloud/instance',
  'var/lib/cloud/instances',
  'var/lib/cloud/sem',
];

export function registerCloudInitWriter(): void {
  registerOperation('deploy.writeCloudInitFiles', async (input) => {
    const { target_path, cloud_cfg, meta_data, user_data, network_config, device_id, phone_home_creds, extra_files } =
      input;
    const safeTarget = assertTargetPathSafe(target_path);

    const inputs: CloudInitInputs = {
      cloud_cfg,
      meta_data,
      user_data,
      network_config,
      device_id,
      phone_home_creds,
    };
    const extras: FileSpec[] = extra_files ?? [];
    // All validation/rendering before any filesystem mutation — a rejected payload must not wipe state or partially write.
    validateCloudInitContent(inputs);
    assertExtraFilesBounded(extras);
    const core = buildFileSpecs(inputs);

    for (const rel of STALE_CLOUDINIT_STATE) {
      await rm(join(safeTarget, rel), { recursive: true, force: true });
    }

    const specs: FileSpec[] = [...core, ...extras];
    const written: string[] = [];

    for (const spec of specs) {
      const full = resolve(join(safeTarget, spec.path));
      if (full !== safeTarget && !full.startsWith(safeTarget + sep)) {
        throw new Error(`rejected file path escaping target: ${spec.path}`);
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, spec.content, { mode: spec.mode });
      await chmod(full, spec.mode);
      written.push(full);
    }

    return { written };
  });
}
