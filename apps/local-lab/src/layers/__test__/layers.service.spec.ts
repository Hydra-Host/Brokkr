import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayersService } from '../layers.service';

describe('LayersService OS-layers manifest default URL', () => {
  const SIM_KEY = 'SIM_OS_LAYERS_MANIFEST_INDEX_URL';
  let savedSim: string | undefined;

  const makeLayers = (originHost: string) =>
    new LayersService({} as never, { originHost: vi.fn().mockReturnValue(originHost) } as never);

  beforeEach(() => {
    savedSim = process.env[SIM_KEY];
    delete process.env[SIM_KEY];
  });
  afterEach(() => {
    if (savedSim === undefined) delete process.env[SIM_KEY];
    else process.env[SIM_KEY] = savedSim;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('derives the default from the effective origin host', () => {
    expect(makeLayers('assets.example.com').layersDefaultUrl()).toBe(
      'https://assets.example.com/os-layers/releases/latest',
    );
  });

  it('returns empty when no origin host is configured', () => {
    expect(makeLayers('').layersDefaultUrl()).toBe('');
  });

  it('prefers an explicit SIM_OS_LAYERS_MANIFEST_INDEX_URL override', () => {
    process.env[SIM_KEY] = 'https://override.example.com/os-layers/releases/v1';
    expect(makeLayers('assets.example.com').layersDefaultUrl()).toBe(
      'https://override.example.com/os-layers/releases/v1',
    );
  });

  it('fetchManifest() with no url throws 400 only when no default is configured', async () => {
    await expect(makeLayers('').fetchManifest()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fetchManifest() with no url fetches the derived default when an origin host is configured', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ groups: [], layers: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').fetchManifest()).resolves.toMatchObject({
      resolvedUrl: 'https://assets.example.com/os-layers/releases/latest',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://assets.example.com/os-layers/releases/latest', expect.anything());
  });
});
