import { dump } from 'js-yaml';
import { z } from 'zod';
import { getErrorMessage } from '../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';
import { isRecord, normalizeSshKey } from '@repo/utils';

import { NonRetryableSagaError } from '../saga-framework/saga-runner.service.js';
import { buildPhoneHomeCreds, CloudInitPayloadError } from './cloud-init-payload.js';
import { createCurtinService } from './curtin.service.js';
import { cleanFstab } from './deploy-templates.js';
import { HTTPSLayerConfigError, sortedKeysRepr, SUPPORTED_DECOMPRESSORS } from './https-layer.service.js';
import type { OsLayer } from './image-source-builder.js';
import { buildHttpsCustomizations, buildHttpsImageSource } from './image-source-builder.js';
import { needsPciReallocOffFromSlug } from './kernel-quirks.js';
import { getDeploymentConfig, getDocaRepoUrl } from './lifecycle-deploy.config.js';

import { getLogger } from '../logger/logger.service';

const logInfo = (msg: string, ctx?: { jobId?: string }): void => void getLogger().info(msg, ctx);
const logWarning = (msg: string, ctx?: { jobId?: string }): void => void getLogger().warning(msg, ctx);
const logError = (msg: string, ctx?: { jobId?: string }): void => void getLogger().error(msg, ctx);

const dispatchToDevice: DeployDispatchFn = () => {
  throw new Error(
    'DeployOrchestrationService requires a `dispatch` dependency injected via DeployOrchestrationDeps; ' +
      'the canonical Dispatcher (agent/dispatch/dispatcher.service.ts) is consumed via NestJS DI, not as a free function.',
  );
};

// Deterministic payload errors that can never succeed on retry; converted to NonRetryableSagaError so the runner fails fast instead of burning retries plus a destructive re-partition/reboot cycle.
function isPermanentDeployError(e: unknown): boolean {
  return e instanceof CloudInitPayloadError || e instanceof HTTPSLayerConfigError;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

const resolvedDiskLayoutSchema = z.object({
  mountpoint: z.string(),
  size_bytes: z.number().int(),
  disks: z.array(z.string()).default([]),
});

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'Array';
  return typeof value;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function iterableLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  throw new TypeError(`expected string | array | object for length check, got ${typeName(value)}`);
}

function toArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'string') {
    if (value === '') return [];
    return Array.from(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (!value) return [];
    throw new TypeError(`'${typeof value}' object is not iterable`);
  }
  if (isRecord(value)) {
    return Object.keys(value);
  }
  throw new TypeError(`'${typeof value}' object is not iterable`);
}

export function parseOsLayers(value: unknown): OsLayer[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new Error('os_layers must be a list');
  }

  for (let i = 0; i < value.length; i += 1) {
    const entry: unknown = value[i];
    if (!isRecord(entry)) {
      throw new Error(`os_layers[${i}] must be a dict`);
    }
    for (const key of ['layer', 'sha256', 'compression', 'stack_position']) {
      if (!(key in entry)) {
        throw new Error(`os_layers[${i}] missing required key '${key}'`);
      }
    }
    const layer = entry['layer'];
    if (typeof layer !== 'string' || layer === '') {
      throw new Error(`os_layers[${i}].layer must be a non-empty string`);
    }
    const sha256 = entry['sha256'];
    if (typeof sha256 !== 'string' || sha256 === '') {
      throw new Error(`os_layers[${i}].sha256 must be a non-empty string`);
    }
    if (!SHA256_RE.test(sha256)) {
      throw new Error(`os_layers[${i}].sha256 must be 64 lowercase hex chars (got '${sha256}')`);
    }
    const compression = entry['compression'];
    if (typeof compression !== 'string' || !Object.hasOwn(SUPPORTED_DECOMPRESSORS, compression)) {
      throw new Error(`os_layers[${i}].compression must be one of ${sortedKeysRepr(SUPPORTED_DECOMPRESSORS)}`);
    }
    const stackPosition = entry['stack_position'];
    if (typeof stackPosition !== 'number' || !Number.isInteger(stackPosition)) {
      throw new Error(`os_layers[${i}].stack_position must be an int`);
    }
  }
  return value as OsLayer[];
}

export class DeployOrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployOrchestrationError';
  }
}

const KERNEL_TO_CURTIN_ARCH: Readonly<Record<string, string>> = {
  x86_64: 'amd64',
  aarch64: 'arm64',
};

export function toCurtinArch(kernelArch: unknown): string {
  if (typeof kernelArch === 'string' && Object.hasOwn(KERNEL_TO_CURTIN_ARCH, kernelArch)) {
    return KERNEL_TO_CURTIN_ARCH[kernelArch] as string;
  }
  throw new NonRetryableSagaError(`unsupported architecture from agent: ${JSON.stringify(kernelArch)}`);
}

export function diskLayoutsForAgent(diskLayouts: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const normalized: Record<string, unknown>[] = [];
  for (const g of diskLayouts) {
    const entry: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(g)) {
      if (k !== 'format') entry[k] = v;
    }
    if ('format' in g) {
      entry['fs_type'] = g['format'];
    }
    if (!('wipe' in entry)) {
      entry['wipe'] = true;
    }
    normalized.push(entry);
  }
  return normalized;
}

export interface OsPayload {
  [key: string]: unknown;
  device_id: string;
  job_id: string;
  os_distro: unknown;
  os_version: unknown;
  os_codename: unknown;
  os_variant: unknown;
  disk_layouts: unknown;
  hostname: unknown;
  pubkeys: unknown;
  user_data: unknown;
  boot_device: unknown;
  os_layers: OsLayer[] | null;
  password_hash: unknown;
  server_token: unknown;
}

export interface ResolvedDeployTarget {
  [key: string]: unknown;
  os_payload: OsPayload;
  disk_layouts: unknown;
}

export interface PreparedStorage {
  [key: string]: unknown;
  arch?: string;
  uefi?: unknown;
  efi_disks?: string[];
  grub_disks?: string[] | null;
  fstab?: unknown;
  crypttab?: unknown;
  disk_layouts?: unknown;
  encrypted_volumes?: unknown[] | null;
  preserved_encrypted_volumes?: unknown;
  target_path?: string;
}

export type DeployDispatchFn = <N extends OperationName>(
  deviceId: string,
  operation: N,
  input: unknown,
  options?: { jobId?: string; timeoutS?: number },
) => Promise<OperationOutput<N>>;

export type NetplanNormalizer = (netplanYaml: string) => string | null;

export interface DeployOrchestrationDeps {
  normalizeNetplanYaml: NetplanNormalizer;
  dispatch?: DeployDispatchFn;
}

// Explicit null must survive (only a missing key defaults to []) so downstream crashes fire instead of a silent empty dispatch.
function rawDiskLayoutsField(lifecycleData: Record<string, unknown>): unknown {
  if (!('disk_layouts' in lifecycleData)) return [];
  return lifecycleData['disk_layouts'];
}

function ensureUnknownArray(target: Record<string, unknown>, key: string): unknown[] {
  if (!(key in target)) {
    target[key] = [];
  }
  const value = target[key];
  if (!Array.isArray(value)) {
    const err = new Error(`expected an array for key '${key}', got ${typeName(value)}`);
    err.name = 'TypeError';
    throw err;
  }
  return value;
}

// Only ValueError-equivalents downgrade to `roce.enabled=false`; TypeError/ReferenceError/SyntaxError must propagate.
function isValueError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof TypeError) return false;
  if (e instanceof ReferenceError) return false;
  if (e instanceof SyntaxError) return false;
  return true;
}

export class DeployOrchestrationService {
  private readonly jobId: string;
  private readonly dispatch: DeployDispatchFn;
  private readonly normalizeNetplanYaml: NetplanNormalizer;

  constructor(jobId: string, deps: DeployOrchestrationDeps) {
    this.jobId = jobId;
    this.dispatch = deps.dispatch ?? dispatchToDevice;
    this.normalizeNetplanYaml = deps.normalizeNetplanYaml;
  }

  async resolveDeployTarget(params: {
    deviceId: string;
    platform: Record<string, unknown>;
    lifecycleData: Record<string, unknown>;
    bootDevice?: string | null;
  }): Promise<ResolvedDeployTarget> {
    const { deviceId, platform, lifecycleData } = params;
    const bootDevice: unknown = 'bootDevice' in params && params.bootDevice !== undefined ? params.bootDevice : 'pxe';

    let diskLayouts: unknown = rawDiskLayoutsField(lifecycleData);
    if (hasValue(diskLayouts)) {
      const items: unknown[] = Array.isArray(diskLayouts)
        ? diskLayouts
        : typeof diskLayouts === 'string'
          ? Array.from(diskLayouts)
          : isRecord(diskLayouts)
            ? Object.keys(diskLayouts)
            : (() => {
                throw new TypeError(`'${typeName(diskLayouts)}' object is not iterable`);
              })();
      const keyed = items.map((entry) => {
        if (!isRecord(entry)) {
          const err = new Error(`expected a record in disk_layouts, got ${typeName(entry)}`);
          err.name = 'TypeError';
          throw err;
        }
        const mp = 'mountpoint' in entry ? entry['mountpoint'] : '';
        return { entry, len: iterableLength(mp) };
      });
      keyed.sort((a, b) => a.len - b.len);
      diskLayouts = keyed.map((k) => k.entry);
    }

    const pubkeys = 'pubkeys' in lifecycleData ? lifecycleData['pubkeys'] : [];

    const dictGet = <T>(d: Record<string, unknown>, key: string, fallback: T): unknown =>
      key in d ? d[key] : fallback;

    const osPayload: OsPayload = {
      device_id: deviceId,
      job_id: this.jobId,
      os_distro: dictGet(platform, 'os_distro', 'ubuntu'),
      os_version: dictGet(platform, 'os_version', '22.04'),
      os_codename: dictGet(platform, 'codename', 'jammy'),
      os_variant: dictGet(platform, 'variant', 'vanilla'),
      disk_layouts: diskLayouts,
      hostname: dictGet(lifecycleData, 'hostname', null),
      pubkeys,
      user_data: dictGet(lifecycleData, 'user_data', null),
      boot_device: bootDevice,
      os_layers: parseOsLayers(lifecycleData['os_layers'] ?? null),
      password_hash: dictGet(lifecycleData, 'password_hash', null),
      server_token: dictGet(lifecycleData, 'server_token', null),
    };

    const diskLayoutsLen = iterableLength(diskLayouts);

    logInfo(
      `OS deploy: distro=${osPayload.os_distro} version=${osPayload.os_version} ` +
        `codename=${osPayload.os_codename} variant=${osPayload.os_variant} ` +
        `hostname=${osPayload.hostname} disk_layouts=${diskLayoutsLen}`,
      { jobId: this.jobId },
    );

    return { os_payload: osPayload, disk_layouts: diskLayouts };
  }

  async prepareStorage(params: {
    deviceId: string;
    diskLayouts: Record<string, unknown>[];
    targetPath?: string;
  }): Promise<PreparedStorage> {
    const { deviceId, diskLayouts } = params;
    const targetPath = params.targetPath ?? '/target';

    try {
      logInfo('Preparing storage for deployment', { jobId: this.jobId });

      const vgResponse = await this.dispatch(
        String(deviceId),
        'storage.detectExistingVolumeGroups',
        {},
        { jobId: this.jobId, timeoutS: 30 },
      );
      const existingVgNames = new Set<string>(vgResponse.volume_group_names);

      const mdResponse = await this.dispatch(
        String(deviceId),
        'storage.detectExistingRaidArrays',
        {},
        { jobId: this.jobId, timeoutS: 30 },
      );
      const existingMdNames = new Set<string>(mdResponse.md_device_names);

      const resolveResponse = await this.dispatch(
        String(deviceId),
        'storage.resolveDisks',
        { disk_layouts: diskLayoutsForAgent(diskLayouts) },
        { jobId: this.jobId, timeoutS: 30 },
      );
      const layoutsParse = z.array(resolvedDiskLayoutSchema).safeParse(resolveResponse.layouts);
      if (!layoutsParse.success) {
        throw new DeployOrchestrationError(
          `storage.resolveDisks returned malformed layouts: ${layoutsParse.error.message}`,
        );
      }
      const resolved = new Map(layoutsParse.data.map((layout) => [layout.mountpoint, layout]));

      for (const group of diskLayouts) {
        const rawMountpoint = group['mountpoint'];
        const mountpoint = rawMountpoint === undefined ? '' : String(rawMountpoint);
        const r = resolved.get(mountpoint);
        if (r === undefined || !r.size_bytes) {
          throw new DeployOrchestrationError(
            `storage.resolveDisks did not return a size for mountpoint ` +
              `${JSON.stringify(group['mountpoint'])}; disk identifiers ${JSON.stringify(group['disks'])} ` +
              `may be unreachable on the device`,
          );
        }
        group['disk_size'] = r.size_bytes;
        if (r.disks.length > 0) {
          group['disks'] = [...r.disks];
        }
      }

      const uefiResponse = await this.dispatch(
        String(deviceId),
        'storage.detectUefiMode',
        {},
        { jobId: this.jobId, timeoutS: 15 },
      );
      const uefiMode = uefiResponse.uefi_mode;

      logInfo(
        `Device storage facts: existing_vgs=${JSON.stringify([...existingVgNames].sort())}, existing_mds=${JSON.stringify([...existingMdNames].sort())}, resolved_layouts=${resolved.size}, uefi=${uefiMode}`,
        { jobId: this.jobId },
      );

      const curtin = await createCurtinService(targetPath, diskLayouts, {
        vgNames: existingVgNames,
        mdNames: existingMdNames,
        jobId: this.jobId,
        uefi: uefiMode,
      });
      await curtin.buildLayout();

      const response = await this.dispatch(
        String(deviceId),
        'storage.prepareStorage',
        {
          disk_layouts: diskLayoutsForAgent(diskLayouts),
          target_path: targetPath,
          curtin_yaml: curtin.yamlContent,
        },
        { jobId: this.jobId, timeoutS: 60 * 60 },
      );

      logInfo('Storage preparation completed successfully', { jobId: this.jobId });

      return {
        arch: toCurtinArch(response.architecture),
        uefi: response.uefi,
        efi_disks: curtin.efiDisks,
        grub_disks: curtin.grubDisks,
        fstab: response.fstab,
        crypttab: response.crypttab,
        disk_layouts: response.resolved_layouts,
        encrypted_volumes: curtin.encryptedVolumes,
        preserved_encrypted_volumes: response.preserved_encrypted_volumes,
        target_path: targetPath,
      };
    } catch (e) {
      // Permanent failures must not be downgraded to retryable — the runner only short-circuits on NonRetryableSagaError.
      if (e instanceof NonRetryableSagaError) {
        logError(`Storage preparation failed (permanent): ${getErrorMessage(e)}`, { jobId: this.jobId });
        throw e;
      }
      if (isPermanentDeployError(e)) {
        logError(`Storage preparation failed (permanent): ${getErrorMessage(e)}`, { jobId: this.jobId });
        throw new NonRetryableSagaError(`Storage preparation failed: ${getErrorMessage(e)}`);
      }
      logError(`Storage preparation failed: ${getErrorMessage(e)}`, { jobId: this.jobId });
      throw new DeployOrchestrationError(`Storage preparation failed: ${getErrorMessage(e)}`);
    }
  }

  async deployOs(params: {
    deviceId: string;
    osPayload: OsPayload;
    storage: PreparedStorage;
    nodeDesc?: string | null;
    deviceNetplan?: string | null;
    deviceGpuModel?: string | null;
    devicePurgeTtys?: boolean;
    deviceSerialPort?: string | null;
    deviceSerialBaud?: number | null;
    deviceType?: string | null;
    deviceNetworkType?: string | null;
  }): Promise<Record<string, unknown>> {
    const { deviceId, osPayload, storage } = params;
    let deviceNetplan = params.deviceNetplan ?? null;

    if (!deviceNetplan) {
      logWarning(`No netplan in payload for device ${deviceId}`, { jobId: this.jobId });
      throw new NonRetryableSagaError(`No netplan available for device ${deviceId}`);
    }

    const normalizedNetplan = this.normalizeNetplanYaml(deviceNetplan);
    if (normalizedNetplan === null) {
      logWarning(`Payload netplan for device ${deviceId} is empty or invalid YAML`, { jobId: this.jobId });
      throw new NonRetryableSagaError(`Payload netplan for device ${deviceId} is empty or invalid YAML`);
    }
    deviceNetplan = normalizedNetplan;

    const passwordHash = osPayload.password_hash;
    const suppliedPubkeys = toArray(osPayload.pubkeys);
    const sshPubkeys = suppliedPubkeys
      .filter((pubkey): pubkey is string => typeof pubkey === 'string')
      .map(normalizeSshKey)
      .filter(Boolean);
    if (suppliedPubkeys.length > 0 && sshPubkeys.length === 0 && !hasValue(passwordHash)) {
      throw new NonRetryableSagaError('All supplied SSH public keys are empty after normalization');
    }

    try {
      if (hasValue(passwordHash)) {
        logWarning(`Password override set for device ${deviceId}`, { jobId: this.jobId });
      }

      const deployConfig = getDeploymentConfig();

      const eastWestIsRoce = params.deviceNetworkType === 'roce';
      const pciReallocOff = needsPciReallocOffFromSlug(params.deviceType);

      const distro = (hasValue(osPayload.os_distro) ? osPayload.os_distro : deployConfig.defaultDistro) as string;
      const osVersion = (hasValue(osPayload.os_version) ? osPayload.os_version : 'latest') as string;
      const arch = ('arch' in storage ? storage['arch'] : 'amd64') as string;
      const uefi = 'uefi' in storage ? hasValue(storage['uefi']) : true;
      const grubDisksRaw = 'grub_disks' in storage ? storage['grub_disks'] : [];
      const grubDisks: unknown = hasValue(grubDisksRaw) ? grubDisksRaw : [];
      const hostname = (hasValue(osPayload.hostname) ? osPayload.hostname : 'brokkr-host') as string;

      const userData = await this.injectInfinibandUdev(
        osPayload.user_data,
        params.nodeDesc ?? null,
        params.deviceNetworkType ?? null,
      );
      const docaCodename = `${distro}${osVersion}`;

      const fstabRaw = 'fstab' in storage ? storage['fstab'] : '';
      if (typeof fstabRaw !== 'string') {
        throw new NonRetryableSagaError(`expected fstab to be a string, got ${typeName(fstabRaw)}`);
      }
      const fstab = cleanFstab(fstabRaw);
      const crypttabRaw = 'crypttab' in storage ? storage['crypttab'] : '';
      const crypttab: unknown = hasValue(crypttabRaw) ? crypttabRaw : '';

      const encryptedNewRaw = storage['encrypted_volumes'];
      const encryptedPreservedRaw = storage['preserved_encrypted_volumes'];
      const encryptedNew = hasValue(encryptedNewRaw) ? toArray(encryptedNewRaw) : [];
      const encryptedPreserved = hasValue(encryptedPreservedRaw) ? toArray(encryptedPreservedRaw) : [];
      // Rekey (luksFormat) targets ONLY new volumes — preserved data must never be reformatted; alreadyKeyed is true only when pure-preserved.
      // Preserved volumes go FIRST: their stored luks_uuid must claim their own arrays in luks-unlock before a new (empty-UUID) volume's first-unclaimed fallback can grab a preserved /dev/mdN.
      const allEncrypted = [...encryptedPreserved, ...encryptedNew];
      const rekeyVolumes = encryptedNew;
      const alreadyKeyed = encryptedNew.length === 0 && encryptedPreserved.length > 0;

      const phoneHome = await buildPhoneHomeCreds({
        deviceId: String(deviceId),
        jobId: this.jobId,
        serverToken: osPayload.server_token,
      });

      const osLayers = parseOsLayers(osPayload.os_layers);
      if (osLayers === null || osLayers.length === 0) {
        throw new NonRetryableSagaError('os_payload.os_layers is required (HTTPS layers are the only deploy path)');
      }

      const imageSource = await buildHttpsImageSource({ jobId: this.jobId, osLayers });
      const customizationPayload = await buildHttpsCustomizations({ jobId: this.jobId, osLayers });

      const cloudInitVars: Record<string, unknown> = {
        device_id: String(deviceId),
        ssh_pubkeys: sshPubkeys,
        netplan_yaml: deviceNetplan,
        phone_home_creds: {
          deployment_os_token: phoneHome.deployment_os_token,
          endpoint: phoneHome.endpoint,
        },
      };
      if (hasValue(passwordHash)) {
        cloudInitVars['password_hash'] = passwordHash;
      }
      if (hasValue(userData)) {
        if (typeof userData === 'string') {
          cloudInitVars['custom_user_data_yaml'] = userData;
        } else {
          cloudInitVars['custom_user_data_yaml'] = dump(userData, {
            sortKeys: true,
            noArrayIndent: true,
            lineWidth: 80,
          });
        }
      }

      const grubVars: Record<string, unknown> = {
        pci_realloc_off: pciReallocOff,
        purge_ttys: params.devicePurgeTtys ?? false,
      };
      if (params.deviceGpuModel) {
        grubVars['gpu_model'] = params.deviceGpuModel;
      }
      if (params.deviceSerialPort) {
        const serialPortsBlock: Record<string, unknown> = { port: params.deviceSerialPort };
        if (params.deviceSerialBaud !== null && params.deviceSerialBaud !== undefined) {
          serialPortsBlock['baud'] = params.deviceSerialBaud;
        }
        grubVars['serial_ports'] = serialPortsBlock;
      }

      const roceVars: Record<string, unknown> = { enabled: eastWestIsRoce, doca_repo_url: '' };
      if (eastWestIsRoce) {
        try {
          roceVars['doca_repo_url'] = getDocaRepoUrl(docaCodename, arch);
        } catch (exc) {
          if (!isValueError(exc)) throw exc;
          logWarning(
            `DOCA repo URL lookup failed; agent-side RoCE injection will be a no-op: ${getErrorMessage(exc)}`,
            {
              jobId: this.jobId,
            },
          );
          roceVars['enabled'] = false;
        }
      }

      const payload: Record<string, unknown> = {
        target_path: 'target_path' in storage ? storage['target_path'] : '/target',
        arch,
        uefi,
        distro,
        hostname,
        grub_disks: grubDisks,
        image: imageSource,
        fstab,
        encrypted_volumes: allEncrypted,
        rekey_volumes: rekeyVolumes,
        roce_iommu: eastWestIsRoce,
        cloud_init_vars: cloudInitVars,
        grub_vars: grubVars,
        luks_already_keyed: alreadyKeyed,
        roce: roceVars,
      };
      if (customizationPayload !== null) {
        payload['customizations'] = customizationPayload;
      }
      if (hasValue(crypttab)) {
        payload['crypttab'] = crypttab;
      }

      logInfo(
        `Dispatching deploy.deployOS for device ${deviceId} (uefi=${uefi}, arch=${arch}, base_sha256=${imageSource.sha256})`,
        {
          jobId: this.jobId,
        },
      );

      const response = await this.dispatch(String(deviceId), 'deploy.deployOS', payload, {
        jobId: this.jobId,
        timeoutS: 1800,
      });

      logInfo('OS deployment completed successfully', { jobId: this.jobId });
      return { ...response };
    } catch (e) {
      if (e instanceof NonRetryableSagaError) {
        logError(`OS deployment failed (permanent): ${getErrorMessage(e)}`, { jobId: this.jobId });
        throw e;
      }
      if (isPermanentDeployError(e)) {
        logError(`OS deployment failed (permanent): ${getErrorMessage(e)}`, { jobId: this.jobId });
        throw new NonRetryableSagaError(`OS deployment failed: ${getErrorMessage(e)}`);
      }
      logError(`OS deployment failed: ${getErrorMessage(e)}`, { jobId: this.jobId });
      throw new DeployOrchestrationError(`OS deployment failed: ${getErrorMessage(e)}`);
    }
  }

  private async injectInfinibandUdev(
    userData: unknown,
    nodeDesc: string | null,
    networkType: string | null,
  ): Promise<unknown> {
    if (!nodeDesc) return userData;

    if (networkType !== 'infiniband') return userData;

    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(nodeDesc)) {
      logWarning(`Skipping InfiniBand node_desc injection: '${nodeDesc}' contains invalid characters`, {
        jobId: this.jobId,
      });
      return userData;
    }

    let target: Record<string, unknown>;
    if (userData === null || userData === undefined) {
      target = {};
    } else if (isRecord(userData)) {
      target = userData;
    } else {
      throw new TypeError(`'${typeof userData}' object does not support item assignment`);
    }

    const ibUdevRule =
      'ACTION=="add", SUBSYSTEM=="infiniband", KERNEL=="mlx5_*", ' +
      `RUN+="/bin/sh -c 'echo -n ${nodeDesc} %k` +
      ` > /sys/class/infiniband/%k/node_desc'"`;
    const writeFiles = ensureUnknownArray(target, 'write_files');
    writeFiles.push({
      path: '/etc/udev/rules.d/99-infiniband-node-desc.rules',
      content: ibUdevRule + '\n',
      permissions: '0644',
    });

    const ibCmd =
      'for d in /sys/class/infiniband/mlx5_*/node_desc; do ' +
      '[ -e "$d" ] && devName=$(basename $(dirname "$d")) && ' +
      `echo -n "${nodeDesc} $devName" > "$d"; done`;
    const runcmd = ensureUnknownArray(target, 'runcmd');
    runcmd.push(ibCmd);
    logInfo(`Injected InfiniBand node_desc udev rule: ${nodeDesc}`, { jobId: this.jobId });

    return target;
  }
}

export async function createDeployOrchestrationService(
  jobId: string,
  deps: DeployOrchestrationDeps,
): Promise<DeployOrchestrationService> {
  return new DeployOrchestrationService(jobId, deps);
}
