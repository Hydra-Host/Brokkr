import { LAYER_SLUGS } from '@repo/layers';
import { parsePlatformSlug } from './platform-slug';

export function isTeeRequested(
  teeFlag: boolean | undefined,
  operatingSystemSlug: string,
  customizations: string[] | null | undefined,
): boolean {
  if (teeFlag) return true;

  const platform = parsePlatformSlug(operatingSystemSlug, '', '');
  if (platform.variant === 'tee') return true;

  if ((customizations ?? []).includes(LAYER_SLUGS.tee.TEE_SETUP)) return true;

  return false;
}
