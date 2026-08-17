import { describe, expect, it } from 'vitest';

import { diskLayoutsForAgent, parseOsLayers } from '../deploy-orchestration.service.js';
import { decompressorFor, HTTPSLayerConfigError, layerUrl, validateLayerPayload } from '../https-layer.service.js';
import type { OsLayer } from '../image-source-builder.js';
import { buildHttpsCustomizations, buildHttpsImageSource } from '../image-source-builder.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function layer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    layer: 'base',
    sha256: SHA_A,
    compression: 'zstd',
    stack_position: 0,
    ...overrides,
  };
}

describe('parseOsLayers', () => {
  it('returns null for absent value', () => {
    expect(parseOsLayers(null)).toBeNull();
    expect(parseOsLayers(undefined)).toBeNull();
  });

  it('rejects non-list values', () => {
    expect(() => parseOsLayers({})).toThrowError('os_layers must be a list');
    expect(() => parseOsLayers('nope')).toThrowError('os_layers must be a list');
  });

  it('rejects non-dict entries', () => {
    expect(() => parseOsLayers(['x'])).toThrowError('os_layers[0] must be a dict');
    expect(() => parseOsLayers([layer(), 7])).toThrowError('os_layers[1] must be a dict');
  });

  it.each(['layer', 'sha256', 'compression', 'stack_position'])('rejects entries missing %s', (key) => {
    const entry = layer();
    delete entry[key];
    expect(() => parseOsLayers([entry])).toThrowError(`os_layers[0] missing required key '${key}'`);
  });

  it('rejects empty or non-string layer name', () => {
    expect(() => parseOsLayers([layer({ layer: '' })])).toThrowError('os_layers[0].layer must be a non-empty string');
    expect(() => parseOsLayers([layer({ layer: 4 })])).toThrowError('os_layers[0].layer must be a non-empty string');
  });

  it('rejects empty or non-string sha256', () => {
    expect(() => parseOsLayers([layer({ sha256: '' })])).toThrowError('os_layers[0].sha256 must be a non-empty string');
    expect(() => parseOsLayers([layer({ sha256: 17 })])).toThrowError('os_layers[0].sha256 must be a non-empty string');
  });

  it.each([
    ['uppercase hex', 'A'.repeat(64)],
    ['0x prefix', `0x${'a'.repeat(62)}`],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex chars', 'g'.repeat(64)],
  ])('rejects loose sha256 forms: %s', (_label, sha) => {
    expect(() => parseOsLayers([layer({ sha256: sha })])).toThrowError(
      `os_layers[0].sha256 must be 64 lowercase hex chars (got '${sha}')`,
    );
  });

  it('rejects unsupported compression', () => {
    expect(() => parseOsLayers([layer({ compression: 'xz' })])).toThrowError(
      "os_layers[0].compression must be one of ['gzip', 'zstd']",
    );
    expect(() => parseOsLayers([layer({ compression: 5 })])).toThrowError(
      "os_layers[0].compression must be one of ['gzip', 'zstd']",
    );
  });

  it('rejects non-int stack_position (including booleans and floats)', () => {
    expect(() => parseOsLayers([layer({ stack_position: true })])).toThrowError(
      'os_layers[0].stack_position must be an int',
    );
    expect(() => parseOsLayers([layer({ stack_position: 1.5 })])).toThrowError(
      'os_layers[0].stack_position must be an int',
    );
    expect(() => parseOsLayers([layer({ stack_position: '1' })])).toThrowError(
      'os_layers[0].stack_position must be an int',
    );
  });

  it('accepts a well-formed layer stack and preserves entries', () => {
    const layers = [layer(), layer({ layer: 'gpu', sha256: SHA_B, compression: 'gzip', stack_position: 1 })];
    const parsed = parseOsLayers(layers);
    expect(parsed).toEqual(layers);
  });

  it('accepts duplicate stack_position values (current contract: no uniqueness check)', () => {
    const layers = [layer(), layer({ layer: 'dup', sha256: SHA_B, stack_position: 0 })];
    expect(parseOsLayers(layers)).toEqual(layers);
  });
});

describe('diskLayoutsForAgent', () => {
  it('renames format to fs_type and defaults wipe', () => {
    const input = [{ mountpoint: '/', format: 'ext4', disks: ['sda'] }];
    expect(diskLayoutsForAgent(input)).toEqual([{ mountpoint: '/', disks: ['sda'], fs_type: 'ext4', wipe: true }]);
  });

  it('keeps explicit wipe and entries without format', () => {
    const input = [{ mountpoint: '/data', wipe: false }];
    expect(diskLayoutsForAgent(input)).toEqual([{ mountpoint: '/data', wipe: false }]);
  });
});

describe('layerUrl', () => {
  it('builds content-addressed URLs from the base', () => {
    expect(layerUrl(SHA_A, 'https://cache.example/blobs')).toBe(`https://cache.example/blobs/sha256:${SHA_A}`);
  });

  it('strips trailing slashes from the base', () => {
    expect(layerUrl(SHA_A, 'https://cache.example/blobs///')).toBe(`https://cache.example/blobs/sha256:${SHA_A}`);
  });
});

describe('validateLayerPayload / decompressorFor', () => {
  it('rejects layers missing required fields', () => {
    expect(() => validateLayerPayload({ sha256: SHA_A, stack_position: 0 })).toThrowError(HTTPSLayerConfigError);
  });

  it('rejects unsupported tar compression', () => {
    expect(() => validateLayerPayload(layer({ compression: 'bzip2' }))).toThrowError(
      "unsupported compression 'bzip2'; supported: ['gzip', 'zstd']",
    );
  });

  it('rejects unsupported image format', () => {
    expect(() => validateLayerPayload(layer({ format: 'qcow2' }))).toThrowError(
      "unsupported image format 'qcow2'; supported: ['tar']",
    );
  });

  it('maps compression names to tar flags', () => {
    expect(decompressorFor('zstd')).toBe('--zstd');
    expect(decompressorFor('gzip')).toBe('-z');
  });
});

describe('buildHttpsImageSource / buildHttpsCustomizations', () => {
  const layers: OsLayer[] = [
    { layer: 'gpu', sha256: SHA_B, compression: 'gzip', stack_position: 2 },
    { layer: 'base', sha256: SHA_A, compression: 'zstd', stack_position: 0 },
    { layer: 'mid', sha256: SHA_C, compression: 'zstd', stack_position: 1 },
  ];

  it('rejects an empty layer list', async () => {
    await expect(buildHttpsImageSource({ jobId: 'j', osLayers: [] })).rejects.toThrowError(
      'os_layers is empty; HTTPS deploy needs at least a base layer',
    );
  });

  it('selects the lowest stack_position as the base image source', async () => {
    const source = await buildHttpsImageSource({ jobId: 'j', osLayers: layers });
    expect(source).toEqual({
      url: expect.stringContaining(`/sha256:${SHA_A}`),
      compression: 'zstd',
      sha256: SHA_A,
    });
  });

  it('returns null customizations for base-only deploys', async () => {
    const single = layers.slice(1, 2);
    await expect(buildHttpsCustomizations({ jobId: 'j', osLayers: single })).resolves.toBeNull();
  });

  it('returns the stacked layers sorted ascending with content-addressed urls', async () => {
    const payload = await buildHttpsCustomizations({ jobId: 'j', osLayers: layers });
    expect(payload).not.toBeNull();
    expect(payload?.layers.map((l) => l.name)).toEqual(['mid', 'gpu']);
    expect(payload?.layers.map((l) => l.stack_position)).toEqual([1, 2]);
    expect(payload?.layers[0]?.url).toContain(`/sha256:${SHA_C}`);
    expect(payload?.layers[1]?.url).toContain(`/sha256:${SHA_B}`);
  });
});
