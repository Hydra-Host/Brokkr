import { Prisma } from '@repo/database';

export function buildPrunableLayerFilter(keepSlugs: string[]): Prisma.LayerWhereInput {
  return {
    slug: { notIn: keepSlugs },
    deploymentLayers: { none: {} },
    baseDeployments: { none: {} },
    rescueDeployments: { none: {} },
  };
}

export function buildReferencedLayerFilter(keepSlugs: string[]): Prisma.LayerWhereInput {
  return {
    slug: { notIn: keepSlugs },
    OR: [{ deploymentLayers: { some: {} } }, { baseDeployments: { some: {} } }, { rescueDeployments: { some: {} } }],
  };
}
