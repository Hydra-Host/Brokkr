import { z } from 'zod';

const PositionSchema = z.array(z.number()).min(2);
const RingSchema = z.array(PositionSchema);
const PolygonCoordinatesSchema = z.array(RingSchema);

export const MultiPolygonGeometrySchema = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(PolygonCoordinatesSchema),
});

export type MultiPolygonGeometry = z.infer<typeof MultiPolygonGeometrySchema>;

export type Position = [number, number];

const EMPTY_MULTIPOLYGON: MultiPolygonGeometry = { type: 'MultiPolygon', coordinates: [] };

export function parseBoundaryOrEmpty(raw: unknown, onInvalid?: () => void): MultiPolygonGeometry {
  const parsed = MultiPolygonGeometrySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  onInvalid?.();
  return EMPTY_MULTIPOLYGON;
}

function pointInRing([x, y]: Position, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Position, rings: number[][][]): boolean {
  if (rings.length === 0 || !pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

export function pointInMultiPolygon(point: Position, geometry: MultiPolygonGeometry): boolean {
  return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
}

export function haversineKm([lng1, lat1]: Position, [lng2, lat2]: Position): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface RegionShape {
  id: string;
  centroid: Position;
  boundary: MultiPolygonGeometry;
}

export function resolveRegionForPoint(lng: number, lat: number, regions: RegionShape[]): string | null {
  if (regions.length === 0) return null;
  const point: Position = [lng, lat];

  const contained = regions.find((region) => pointInMultiPolygon(point, region.boundary));
  if (contained) return contained.id;

  let nearest = regions[0];
  let nearestDist = haversineKm(point, regions[0].centroid);
  for (let i = 1; i < regions.length; i++) {
    const dist = haversineKm(point, regions[i].centroid);
    if (dist < nearestDist) {
      nearest = regions[i];
      nearestDist = dist;
    }
  }
  return nearest.id;
}
