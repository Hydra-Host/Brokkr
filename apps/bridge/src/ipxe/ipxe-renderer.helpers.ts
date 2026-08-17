import { needsPciReallocOffFromSlug } from '../lifecycle-deploy/kernel-quirks';

import { IpxeServiceError } from './ipxe-errors';

export const SUPPORTED_ARCHS: ReadonlyArray<string> = ['amd64', 'arm64', 'x86_64', 'aarch64'];

const ARCH_MAP: Record<string, string> = {
  x86_64: 'amd64',
  amd64: 'amd64',
  arm64: 'arm64',
  aarch64: 'arm64',
};

export function archSlug(buildarch: string | null | undefined): string | null {
  if (typeof buildarch !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(ARCH_MAP, buildarch) ? ARCH_MAP[buildarch] : null;
}

export function platformTypeFromTags(platformTags: string[] | null | undefined): string {
  if (!platformTags) return 'inventory';
  return platformTags.includes('rescue') ? 'rescue' : 'inventory';
}

export function needsPciReallocOff(deviceType: string | null | undefined): boolean {
  return needsPciReallocOffFromSlug(deviceType ?? null);
}

const SUPPORTED_GRUB_PAIRS: ReadonlySet<string> = new Set(['amd64:efi', 'amd64:pcbios', 'arm64:efi']);

export function grubChainSupported(arch: string, platform: string): boolean {
  return SUPPORTED_GRUB_PAIRS.has(`${arch}:${platform}`);
}

export function normalizeMacForInitrd(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, '');
}

export interface RenderRequest {
  platform: string;
  buildarch: string;
  mac_address: string;
  retry_count?: number;
}

export function validateRenderRequest(request: RenderRequest): void {
  if (!SUPPORTED_ARCHS.includes(request.buildarch)) {
    throw new IpxeServiceError(`Unsupported architecture: ${formatBuildarchForError(request.buildarch)}`);
  }
}

function formatBuildarchForError(buildarch: unknown): string {
  if (buildarch === null) return 'null';
  if (buildarch === undefined) return 'null';
  return String(buildarch);
}
