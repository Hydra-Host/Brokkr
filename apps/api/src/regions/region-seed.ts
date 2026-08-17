import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from 'src/common/error-utils';
import { z } from 'zod';
import { MultiPolygonGeometrySchema } from './geo';

const RegionSeedSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be kebab-case'),
  name: z.string().min(1),
  description: z.string().optional(),
  priority: z.number().int().default(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex value')
    .optional(),
  centroidLat: z.number().min(-90).max(90),
  centroidLng: z.number().min(-180).max(180),
  boundary: MultiPolygonGeometrySchema,
});

export const RegionSeedFileSchema = z
  .array(RegionSeedSchema)
  .min(1, 'at least one region is required')
  .superRefine((regions, context) => {
    const slugs = new Set<string>();
    const names = new Set<string>();
    for (const region of regions) {
      if (slugs.has(region.slug)) {
        context.addIssue({ code: 'custom', message: `duplicate region slug "${region.slug}"` });
      }
      if (names.has(region.name)) {
        context.addIssue({ code: 'custom', message: `duplicate region name "${region.name}"` });
      }
      slugs.add(region.slug);
      names.add(region.name);
    }
  });

export type RegionSeed = z.infer<typeof RegionSeedSchema>;

export const DEFAULT_REGIONS_FILE = path.resolve(__dirname, '..', '..', 'config', 'regions.json');

export function loadRegionSeeds(filePath: string = DEFAULT_REGIONS_FILE): RegionSeed[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read region definitions file ${filePath}: ${getErrorMessage(error)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`region definitions file ${filePath} is not valid JSON: ${getErrorMessage(error)}`);
  }

  const parsed = RegionSeedFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`region definitions file ${filePath} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
