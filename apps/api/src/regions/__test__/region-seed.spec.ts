import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRegionSeeds } from '../region-seed';

const VALID_REGION = {
  slug: 'test-region',
  name: 'Test Region',
  description: 'A test region.',
  priority: 10,
  color: '#3b82f6',
  centroidLat: 50.1,
  centroidLng: 8.7,
  boundary: {
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
  },
};

describe('region seed loader', () => {
  let directory: string;

  const writeFixture = (content: unknown): string => {
    const file = path.join(directory, 'regions.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'region-seed-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads the checked-in continent definitions', () => {
    const regions = loadRegionSeeds();
    expect(regions.map((region) => region.slug)).toContain('north-america');
  });

  it('ships boundaries without antimeridian jumps', () => {
    for (const region of loadRegionSeeds()) {
      for (const polygon of region.boundary.coordinates) {
        for (const ring of polygon) {
          for (let index = 1; index < ring.length; index++) {
            expect(Math.abs(ring[index][0] - ring[index - 1][0])).toBeLessThanOrEqual(180);
          }
        }
      }
    }
  });

  it('applies defaults for optional fields', () => {
    const { priority: _priority, color: _color, description: _description, ...minimal } = VALID_REGION;
    const [region] = loadRegionSeeds(writeFixture([minimal]));
    expect(region.priority).toBe(100);
    expect(region.color).toBeUndefined();
    expect(region.description).toBeUndefined();
  });

  it('rejects unreadable, malformed, and empty files', () => {
    expect(() => loadRegionSeeds(path.join(directory, 'missing.json'))).toThrow(/cannot read/);
    expect(() => loadRegionSeeds(writeFixture('{not json'))).toThrow(/not valid JSON/);
    expect(() => loadRegionSeeds(writeFixture([]))).toThrow(/at least one region/);
  });

  it('rejects invalid fields and duplicate identifiers', () => {
    expect(() => loadRegionSeeds(writeFixture([{ ...VALID_REGION, centroidLat: 99 }]))).toThrow(/failed validation/);
    expect(() => loadRegionSeeds(writeFixture([{ ...VALID_REGION, slug: 'Not Kebab' }]))).toThrow(/failed validation/);
    expect(() => loadRegionSeeds(writeFixture([{ ...VALID_REGION, color: 'blue' }]))).toThrow(/failed validation/);
    expect(() => loadRegionSeeds(writeFixture([VALID_REGION, VALID_REGION]))).toThrow(/duplicate region slug/);
    expect(() => loadRegionSeeds(writeFixture([VALID_REGION, { ...VALID_REGION, slug: 'other-region' }]))).toThrow(
      /duplicate region name/,
    );
  });
});
