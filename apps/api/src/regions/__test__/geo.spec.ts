import { describe, expect, it, vi } from 'vitest';
import {
  haversineKm,
  parseBoundaryOrEmpty,
  pointInMultiPolygon,
  resolveRegionForPoint,
  type RegionShape,
} from '../geo';
import { loadRegionSeeds } from '../region-seed';

const REGIONS: RegionShape[] = loadRegionSeeds()
  .sort((a, b) => a.priority - b.priority)
  .map((r) => ({ id: r.slug, centroid: [r.centroidLng, r.centroidLat], boundary: r.boundary }));

describe('geo: point-in-polygon', () => {
  const unitSquare = {
    type: 'MultiPolygon' as const,
    coordinates: [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    ],
  };

  it('detects a point inside the polygon', () => {
    expect(pointInMultiPolygon([5, 5], unitSquare)).toBe(true);
  });

  it('rejects a point outside the polygon', () => {
    expect(pointInMultiPolygon([15, 5], unitSquare)).toBe(false);
    expect(pointInMultiPolygon([5, -1], unitSquare)).toBe(false);
  });
});

describe('geo: parseBoundaryOrEmpty', () => {
  const validBoundary = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    ],
  };

  it('returns the parsed geometry for a valid boundary', () => {
    expect(parseBoundaryOrEmpty(validBoundary)).toEqual(validBoundary);
  });

  it('degrades a malformed boundary to an empty MultiPolygon and fires onInvalid', () => {
    const onInvalid = vi.fn();
    expect(parseBoundaryOrEmpty({ type: 'Polygon', coordinates: 'nope' }, onInvalid)).toEqual({
      type: 'MultiPolygon',
      coordinates: [],
    });
    expect(onInvalid).toHaveBeenCalledOnce();
  });

  it('does not fire onInvalid for a valid boundary', () => {
    const onInvalid = vi.fn();
    parseBoundaryOrEmpty(validBoundary, onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});

describe('geo: haversine', () => {
  it('is ~0 for the same point', () => {
    expect(haversineKm([0, 0], [0, 0])).toBeCloseTo(0, 5);
  });

  it('approximates a known distance (London → Frankfurt ~ 640 km)', () => {
    const km = haversineKm([-0.1, 51.5], [8.7, 50.1]);
    expect(km).toBeGreaterThan(600);
    expect(km).toBeLessThan(680);
  });
});

describe('region assignment over the seeded boundaries', () => {
  const cases: Array<[string, number, number, string]> = [
    ['Dallas', -96.8, 32.8, 'north-america'],
    ['Ashburn', -77.5, 39.0, 'north-america'],
    ['Mexico City', -99.1, 19.4, 'central-america'],
    ['São Paulo', -46.6, -23.5, 'south-america'],
    ['London', -0.1, 51.5, 'europe'],
    ['Frankfurt', 8.7, 50.1, 'europe'],
    ['Cairo', 31.2, 30.0, 'africa'],
    ['Johannesburg', 28.0, -26.2, 'africa'],
    ['Dubai', 55.3, 25.2, 'middle-east'],
    ['Mumbai', 72.9, 19.1, 'asia'],
    ['Tokyo', 139.7, 35.7, 'asia'],
    ['Singapore', 103.8, 1.35, 'asia'],
    ['Sydney', 151.2, -33.9, 'oceania'],
  ];

  it.each(cases)('assigns %s to %s', (_name, lng, lat, expected) => {
    expect(resolveRegionForPoint(lng, lat, REGIONS)).toBe(expected);
  });

  it('falls back to the nearest centroid when outside every boundary', () => {
    const result = resolveRegionForPoint(-40, 35, REGIONS);
    expect(result).not.toBeNull();
  });

  it('returns null when there are no regions', () => {
    expect(resolveRegionForPoint(0, 0, [])).toBeNull();
  });

  it('still resolves via centroid when every boundary is empty', () => {
    const emptyBoundaryRegions: RegionShape[] = REGIONS.map((r) => ({
      ...r,
      boundary: { type: 'MultiPolygon', coordinates: [] },
    }));
    expect(resolveRegionForPoint(8.7, 50.1, emptyBoundaryRegions)).toBe('europe');
  });
});
