import type { PrismaClient } from '@repo/database';
import { LayerBuildStatus } from '@repo/database';
import { LayerBuildRecord } from './layer-build.record';
import { PlatformSettingsRecord } from './platform-settings.record';

export class LayerBuildResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerBuildResolutionError';
  }
}

type ExceptionFactory = new (message: string) => Error;

export async function resolveEffectiveBuild(
  zone: { id: string; layerBuildId: string | null },
  opts: { Exception?: ExceptionFactory; prefetchedDefaultBuildId?: string | null } = {},
): Promise<string> {
  const Exception = opts.Exception ?? LayerBuildResolutionError;
  let buildId = zone.layerBuildId;
  let source: 'zone-pin' | 'global-default';

  if (buildId) {
    source = 'zone-pin';
  } else if (opts.prefetchedDefaultBuildId !== undefined) {
    buildId = opts.prefetchedDefaultBuildId;
    source = 'global-default';
  } else {
    const settings = await PlatformSettingsRecord.get();
    buildId = settings.defaultLayerBuildId;
    source = 'global-default';
  }

  if (!buildId) {
    throw new Exception(
      `Zone ${zone.id} has no layer build assigned and no global default is configured. ` +
        `Import a layer manifest and set it as the default build.`,
    );
  }

  const build = await LayerBuildRecord.findById(buildId);
  if (!build) {
    const detail =
      source === 'zone-pin'
        ? `Zone ${zone.id} is pinned to build ${buildId} which does not exist.`
        : `Global default build ${buildId} does not exist.`;
    throw new Exception(`${detail} Re-import or reassign the layer build.`);
  }

  if (build.status !== LayerBuildStatus.READY) {
    const detail =
      source === 'zone-pin'
        ? `Zone ${zone.id} is pinned to build ${buildId} which has status "${build.status}".`
        : `Global default build ${buildId} has status "${build.status}".`;
    throw new Exception(`${detail} Only READY builds can serve layer artifacts.`);
  }

  return buildId;
}

export async function resolveZoneBuildId(
  prisma: PrismaClient,
  zoneId: string | null,
  opts: { strict?: boolean; Exception?: ExceptionFactory } = {},
): Promise<string | null> {
  if (!zoneId) {
    if (opts.strict) {
      const Exception = opts.Exception ?? LayerBuildResolutionError;
      throw new Exception('Cannot provision: device has no zone assigned');
    }
    return null;
  }
  const zone = await prisma.zone.findUnique({
    where: { id: zoneId, deletedAt: null },
    select: { id: true, layerBuildId: true },
  });
  if (!zone) {
    if (opts.strict) {
      const Exception = opts.Exception ?? LayerBuildResolutionError;
      throw new Exception(`Cannot provision: zone ${zoneId} is missing or has been deleted`);
    }
    return null;
  }
  return resolveEffectiveBuild(zone, { Exception: opts.Exception });
}
