import { z } from 'zod';

const GeoJsonPositionSchema = z
  .array(z.number())
  .min(2)
  .describe('GeoJSON position: [longitude, latitude] (optional 3rd elevation element allowed)');

export const GeoJsonMultiPolygonSchema = z
  .object({
    type: z.literal('MultiPolygon').describe('GeoJSON geometry type — always "MultiPolygon"'),
    coordinates: z
      .array(z.array(z.array(GeoJsonPositionSchema)))
      .describe('Array of polygons; each polygon is an array of linear rings; each ring is an array of positions'),
  })
  .describe('Region boundary as a GeoJSON MultiPolygon geometry');

export type GeoJsonMultiPolygon = z.infer<typeof GeoJsonMultiPolygonSchema>;

export const RegionResponseSchema = z.object({
  id: z.string().describe('Unique identifier for the region'),
  slug: z.string().describe('URL-friendly region identifier (e.g. "north-america")'),
  name: z.string().describe('Display name of the region (e.g. "North America")'),
  description: z.string().nullable().describe('Human-readable description of what the region covers'),
  color: z.string().nullable().describe('Hex color (e.g. "#3b82f6") for rendering the region on a map'),
  centroidLat: z.number().describe('Latitude of the region anchor/centroid, for label placement and fallback'),
  centroidLng: z.number().describe('Longitude of the region anchor/centroid, for label placement and fallback'),
  boundary: GeoJsonMultiPolygonSchema.describe('Custom geographic boundary used for assignment and map rendering'),
});

export type RegionResponse = z.infer<typeof RegionResponseSchema>;
