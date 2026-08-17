import type { PrismaClient } from '@repo/database';
import { LayerBuildStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerBuildRecord } from '../layer-build.record';
import { PlatformSettingsRecord } from '../platform-settings.record';
import { LayerBuildResolutionError, resolveEffectiveBuild, resolveZoneBuildId } from '../resolve-effective-build';

const ZONE_ID = 'zone-1';
const BUILD_ID = 'build-abc';

class CustomException extends Error {}

describe('resolveEffectiveBuild', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe('zone-pin path', () => {
    it('returns the build id when the zone pin exists and is READY', async () => {
      vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue({
        id: BUILD_ID,
        status: LayerBuildStatus.READY,
      } as Awaited<ReturnType<typeof LayerBuildRecord.findById>> & object);

      const result = await resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: BUILD_ID });

      expect(result).toBe(BUILD_ID);
      expect(LayerBuildRecord.findById).toHaveBeenCalledWith(BUILD_ID);
    });

    it('throws when the pinned build does not exist', async () => {
      vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue(null);

      await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: BUILD_ID })).rejects.toThrow(
        LayerBuildResolutionError,
      );
      await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: BUILD_ID })).rejects.toThrow(/pinned to build/);
    });

    it.each([LayerBuildStatus.IMPORTING, LayerBuildStatus.FAILED, LayerBuildStatus.RETIRED])(
      'throws when the pinned build has status %s',
      async (status) => {
        vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue({
          id: BUILD_ID,
          status,
        } as Awaited<ReturnType<typeof LayerBuildRecord.findById>> & object);

        await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: BUILD_ID })).rejects.toThrow(
          LayerBuildResolutionError,
        );
        await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: BUILD_ID })).rejects.toThrow(
          new RegExp(`pinned to build ${BUILD_ID} which has status "${status}"`),
        );
      },
    );
  });

  it('throws the caller-specified exception class instead of LayerBuildResolutionError', async () => {
    vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue(null);

    await expect(
      resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: BUILD_ID }, { Exception: CustomException }),
    ).rejects.toThrow(CustomException);
  });

  it('uses prefetchedDefaultBuildId instead of fetching PlatformSettings', async () => {
    const getSpy = vi.spyOn(PlatformSettingsRecord, 'get');
    vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue({
      id: BUILD_ID,
      status: LayerBuildStatus.READY,
    } as Awaited<ReturnType<typeof LayerBuildRecord.findById>> & object);

    const result = await resolveEffectiveBuild(
      { id: ZONE_ID, layerBuildId: null },
      { prefetchedDefaultBuildId: BUILD_ID },
    );

    expect(result).toBe(BUILD_ID);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('treats an explicit null prefetchedDefaultBuildId as no default (hydration batch path)', async () => {
    const getSpy = vi.spyOn(PlatformSettingsRecord, 'get');

    await expect(
      resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null }, { prefetchedDefaultBuildId: null }),
    ).rejects.toThrow(/no global default is configured/);
    expect(getSpy).not.toHaveBeenCalled();
  });

  describe('global-default fallback path', () => {
    it('returns the build id from platform settings when zone has no pin', async () => {
      vi.spyOn(PlatformSettingsRecord, 'get').mockResolvedValue({
        defaultLayerBuildId: BUILD_ID,
      } as Awaited<ReturnType<typeof PlatformSettingsRecord.get>>);
      vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue({
        id: BUILD_ID,
        status: LayerBuildStatus.READY,
      } as Awaited<ReturnType<typeof LayerBuildRecord.findById>> & object);

      const result = await resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null });

      expect(result).toBe(BUILD_ID);
      expect(PlatformSettingsRecord.get).toHaveBeenCalled();
      expect(LayerBuildRecord.findById).toHaveBeenCalledWith(BUILD_ID);
    });

    it('throws when both zone pin and global default are null', async () => {
      vi.spyOn(PlatformSettingsRecord, 'get').mockResolvedValue({
        defaultLayerBuildId: null,
      } as Awaited<ReturnType<typeof PlatformSettingsRecord.get>>);

      await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null })).rejects.toThrow(
        LayerBuildResolutionError,
      );
      await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null })).rejects.toThrow(
        /no global default is configured/,
      );
    });

    it('throws when the global default build does not exist', async () => {
      vi.spyOn(PlatformSettingsRecord, 'get').mockResolvedValue({
        defaultLayerBuildId: BUILD_ID,
      } as Awaited<ReturnType<typeof PlatformSettingsRecord.get>>);
      vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue(null);

      await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null })).rejects.toThrow(
        LayerBuildResolutionError,
      );
      await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null })).rejects.toThrow(
        /Global default build .+ does not exist/,
      );
    });

    it.each([LayerBuildStatus.IMPORTING, LayerBuildStatus.FAILED, LayerBuildStatus.RETIRED])(
      'throws when the global default build has status %s',
      async (status) => {
        vi.spyOn(PlatformSettingsRecord, 'get').mockResolvedValue({
          defaultLayerBuildId: BUILD_ID,
        } as Awaited<ReturnType<typeof PlatformSettingsRecord.get>>);
        vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue({
          id: BUILD_ID,
          status,
        } as Awaited<ReturnType<typeof LayerBuildRecord.findById>> & object);

        await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null })).rejects.toThrow(
          LayerBuildResolutionError,
        );
        await expect(resolveEffectiveBuild({ id: ZONE_ID, layerBuildId: null })).rejects.toThrow(
          new RegExp(`Global default build ${BUILD_ID} has status "${status}"`),
        );
      },
    );
  });
});

describe('resolveZoneBuildId', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  function makePrisma(zone: { id: string; layerBuildId: string | null } | null): PrismaClient {
    return { zone: { findUnique: vi.fn().mockResolvedValue(zone) } } as unknown as PrismaClient;
  }

  it('returns null for a missing/soft-deleted zone on the fail-soft (catalog) path', async () => {
    expect(await resolveZoneBuildId(makePrisma(null), ZONE_ID)).toBeNull();
  });

  it('throws for a missing/soft-deleted zone on the strict (mutation) path', async () => {
    await expect(resolveZoneBuildId(makePrisma(null), ZONE_ID, { strict: true })).rejects.toThrow(
      LayerBuildResolutionError,
    );
    await expect(resolveZoneBuildId(makePrisma(null), ZONE_ID, { strict: true })).rejects.toThrow(
      /missing or has been deleted/,
    );
  });

  it('returns null for a null zoneId when not strict', async () => {
    expect(await resolveZoneBuildId(makePrisma(null), null)).toBeNull();
  });

  it('throws for a null zoneId on the strict (mutation) path', async () => {
    await expect(resolveZoneBuildId(makePrisma(null), null, { strict: true })).rejects.toThrow(
      LayerBuildResolutionError,
    );
    await expect(resolveZoneBuildId(makePrisma(null), null, { strict: true })).rejects.toThrow(/no zone assigned/);
  });

  it('resolves the effective build when the zone exists (strict)', async () => {
    vi.spyOn(LayerBuildRecord, 'findById').mockResolvedValue({
      id: BUILD_ID,
      status: LayerBuildStatus.READY,
    } as Awaited<ReturnType<typeof LayerBuildRecord.findById>> & object);

    const result = await resolveZoneBuildId(makePrisma({ id: ZONE_ID, layerBuildId: BUILD_ID }), ZONE_ID, {
      strict: true,
    });

    expect(result).toBe(BUILD_ID);
  });
});
