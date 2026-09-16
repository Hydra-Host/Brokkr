import type { DeviceRecord } from '../device-record/device-record.schema';
import { isPlaceholder } from '../device-record/device-record.schema';
import type { DiscoveryFlavor } from '../download/discovery.config';

import { sanitizeChainJobId } from './chain.helpers';
import { NIL_DEVICE_ID, RESCUE_OS_SLUG, type RendererCall, type RenderForRecordContext } from './chain.types';
import { IpxeServerTokenUnavailableError, IpxeServiceError } from './ipxe-errors';
import {
  archSlug,
  grubChainSupported,
  needsPciReallocOff,
  platformTypeFromTags,
  type RenderRequest,
} from './ipxe-renderer.helpers';

// C0 control chars (incl. CR/LF) + DEL would break out of the rendered iPXE line; string-built to keep literal control bytes out of source.
// eslint-disable-next-line no-control-regex -- deliberate: match C0 control chars + DEL
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');

export function isSafeIpxeUrl(url: string): boolean {
  if (CONTROL_CHARS.test(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const MAX_KNOWN_RECORD_MISSING_RETRIES = 5;

export const DISCOVERY_LIGHT_TAG = 'discovery-light';

// a lone configured flavor is the only synced tree, so it boots every device regardless of tags;
// with both, an operator tags a device discovery-light to pick the light image over the full one
export function flavorForDevice(
  platformTags: readonly string[] | null | undefined,
  configured: readonly DiscoveryFlavor[],
): DiscoveryFlavor {
  if (configured.length === 1) return configured[0];
  return platformTags?.includes(DISCOVERY_LIGHT_TAG) ? 'light' : 'full';
}

export async function renderForRecord(ctx: RenderForRecordContext): Promise<string> {
  const { record, request, renderer } = ctx;
  const events = ctx.events;

  const arch = archSlug(request.buildarch);
  if (arch === null) {
    const kwargs = { buildarch: request.buildarch, platform: request.platform };
    return recordCall(events, () => renderer.render_unknown(kwargs), 'render_unknown', kwargs);
  }

  if (record === 'KNOWN_RECORD_MISSING') {
    const retries = request.retry_count ?? 0;
    if (retries >= MAX_KNOWN_RECORD_MISSING_RETRIES) {
      // Atom never republished after bounded retries: commission via brokkr-live rather than re-chain forever.
      return renderUnknownDiscovery(ctx, arch);
    }
    const kwargs = { retry_count: retries + 1 };
    return recordCall(events, () => renderer.render_retry(kwargs), 'render_retry', kwargs);
  }

  if (typeof record === 'string') {
    if (ctx.pendingRegistered ?? false) {
      return renderUnknownDiscovery(ctx, arch);
    }
    const retries = request.retry_count ?? 0;
    if (retries >= MAX_KNOWN_RECORD_MISSING_RETRIES) {
      return renderUnknownDiscovery(ctx, arch);
    }
    const kwargs = { retry_count: retries + 1 };
    return recordCall(events, () => renderer.render_retry(kwargs), 'render_retry', kwargs);
  }

  const customScript = await maybeRenderCustomIpxe(ctx);
  if (customScript !== null) return customScript;

  return generateScriptByStatus(record, request, arch, ctx);
}

function renderUnknownDiscovery(ctx: RenderForRecordContext, arch: string): Promise<string> {
  const { request, jobId, renderer, events } = ctx;
  const pendingRegistered = ctx.pendingRegistered ?? false;
  const hasMac = Boolean(request.mac_address);
  const perMacBuildable = pendingRegistered && hasMac;
  const kwargs = {
    arch,
    platform: request.platform,
    platform_type: 'inventory',
    device_id: NIL_DEVICE_ID,
    serial_port: null,
    serial_baud: null,
    job_id: jobId,
    kernel_network: [] as string[],
    pci_realloc_off: false,
    flavor: flavorForDevice(null, ctx.discoveryFlavors),
    mac: perMacBuildable ? request.mac_address : undefined,
    is_placeholder_device: perMacBuildable,
  };
  return recordCall(events, () => renderer.render_discovery(kwargs), 'render_discovery', kwargs);
}

async function maybeRenderCustomIpxe(ctx: RenderForRecordContext): Promise<string | null> {
  const { record, request, jobId, renderer, events } = ctx;
  if (typeof record === 'string') return null;
  if (isPlaceholder(record)) return null;

  const status = (record.status ?? '').toLowerCase();
  const installedOs = record.installed_os ?? '';
  if (status !== 'provisioning' || (installedOs !== 'ipxe-custom' && installedOs !== 'ipxe-custom-tee')) {
    return null;
  }

  const effectiveJobId = sanitizeChainJobId(jobId || (record.last_job_id ?? ''));
  // Redis lookup only after the gates pass, and a lookup throw degrades to the normal boot path — a Redis outage must not 500 every boot.
  let ipxeUrl: string | null = ctx.redisIpxeUrl ?? null;
  if (!ipxeUrl && ctx.redisIpxeUrlLookup) {
    try {
      ipxeUrl = await ctx.redisIpxeUrlLookup(record.id, effectiveJobId);
    } catch {
      return null;
    }
  }
  if (!ipxeUrl) return null;
  // Even hub-minted URLs get the injection guard; unsafe values fall through to the status-based script instead of a poisoned boot script.
  if (!isSafeIpxeUrl(ipxeUrl)) return null;
  void request;

  const kwargs = {
    ipxe_url: ipxeUrl,
    device_id: record.id,
    job_id: effectiveJobId,
  };
  try {
    return await recordCall(events, () => renderer.render_custom(kwargs), 'render_custom', kwargs);
  } catch (error) {
    if (error instanceof IpxeServerTokenUnavailableError) {
      const retries = request.retry_count ?? 0;
      if (retries < MAX_KNOWN_RECORD_MISSING_RETRIES) {
        const retryKwargs = { retry_count: retries + 1 };
        return recordCall(events, () => renderer.render_retry(retryKwargs), 'render_retry', retryKwargs);
      }
    } else if (error instanceof IpxeServiceError) {
      return null;
    }
    throw error;
  }
}

async function generateScriptByStatus(
  record: DeviceRecord,
  request: RenderRequest,
  arch: string,
  ctx: RenderForRecordContext,
): Promise<string> {
  const { jobId, renderer, events } = ctx;
  const discoveryPlatformSlug = ctx.discoveryPlatformSlug ?? 'brokkr-discovery';
  const installedOs = record.installed_os ?? null;
  const rescueOs = record.rescue_os ?? null;
  const deviceId = record.id;
  const serialPort = record.serial_port_recommended ?? null;
  const serialBaud = record.serial_baud_recommended ?? null;
  const placeholder = isPlaceholder(record);
  const effectiveJobId = sanitizeChainJobId(jobId || (record.last_job_id ?? ''));
  const discoverySlugs = new Set<string>([discoveryPlatformSlug, RESCUE_OS_SLUG]);
  const platformType = platformTypeFromTags(record.platform_tags);
  const flavor = flavorForDevice(record.platform_tags, ctx.discoveryFlavors);
  const pciReallocOff = needsPciReallocOff(record.device_type);

  const dispatchDiscovery = async (): Promise<string> => {
    const kernelNetwork = ctx.getKernelNetworkParams ? await ctx.getKernelNetworkParams(record, effectiveJobId) : [];
    const kwargs: Record<string, unknown> = {
      arch,
      platform: request.platform,
      platform_type: platformType,
      device_id: deviceId,
      serial_port: serialPort,
      serial_baud: serialBaud,
      job_id: effectiveJobId,
      kernel_network: kernelNetwork,
      pci_realloc_off: pciReallocOff,
      flavor,
      mac: request.mac_address,
      is_placeholder_device: placeholder,
    };
    return recordCall(events, () => renderer.render_discovery(kwargs), 'render_discovery', kwargs);
  };

  if (rescueOs != null || placeholder) {
    return dispatchDiscovery();
  }
  if (installedOs == null) {
    await triggerInventory(ctx, deviceId, effectiveJobId);
    return dispatchDiscovery();
  }
  if (discoverySlugs.has(installedOs)) {
    return dispatchDiscovery();
  }

  const kwargs = {
    platform: request.platform,
    arch,
    job_id: effectiveJobId,
    grub_supported: grubChainSupported(arch, request.platform),
  };
  return recordCall(events, () => renderer.render_disk(kwargs), 'render_disk', kwargs);
}

async function triggerInventory(ctx: RenderForRecordContext, deviceId: string, jobId: string): Promise<void> {
  if (ctx.events) {
    ctx.events.push({ method: 'inventory_trigger', kwargs: { device_id: deviceId, job_id: jobId } });
  }
  if (ctx.triggerInventoryCollection) {
    try {
      await ctx.triggerInventoryCollection(deviceId, jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ctx.inventoryTriggerLogger) {
        await ctx.inventoryTriggerLogger.warn(`Failed to trigger inventory_collection (non-fatal): ${message}`, {
          jobId,
          deviceId,
        });
      }
    }
  }
}

async function recordCall<T>(
  events: RendererCall[] | undefined,
  fn: () => Promise<T>,
  method: RendererCall['method'],
  kwargs: Record<string, unknown>,
): Promise<T> {
  if (events) events.push({ method, kwargs });
  return fn();
}
