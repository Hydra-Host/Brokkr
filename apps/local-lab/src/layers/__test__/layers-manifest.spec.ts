import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayersService } from '../layers.service';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const redirect = (location: string) => ({
  status: 302,
  headers: { get: (h: string) => (h === 'location' ? location : null) },
});
const MANIFEST = { groups: [], layers: [] };

const makeLayers = (originHost: string, runner: Record<string, unknown> = {}) =>
  new LayersService(runner as never, { originHost: vi.fn().mockReturnValue(originHost) } as never);

describe('LayersService.fetchManifest allowlist', () => {
  beforeEach(() => {
    vi.stubEnv('SIM_OS_LAYERS_MANIFEST_INDEX_URL', '');
    vi.stubEnv('LAB_LAYERS_ALLOWED_HOSTS', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('accepts a URL on the overlay origin host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(MANIFEST)),
    );
    const svc = makeLayers('assets.example.com');
    await expect(svc.fetchManifest('https://assets.example.com/os-layers/releases/v1')).resolves.toEqual({
      resolvedUrl: 'https://assets.example.com/os-layers/releases/v1',
      doc: MANIFEST,
    });
  });

  it('accepts a URL on the SIM_OS_LAYERS_MANIFEST_INDEX_URL host', async () => {
    vi.stubEnv('SIM_OS_LAYERS_MANIFEST_INDEX_URL', 'https://sim-host.example.com/index');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(MANIFEST)),
    );
    await expect(makeLayers('').fetchManifest('https://sim-host.example.com/m.json')).resolves.toMatchObject({
      resolvedUrl: 'https://sim-host.example.com/m.json',
    });
  });

  it('accepts a URL on a LAB_LAYERS_ALLOWED_HOSTS host', async () => {
    vi.stubEnv('LAB_LAYERS_ALLOWED_HOSTS', 'extra.example.com other.example.com');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(MANIFEST)),
    );
    await expect(makeLayers('').fetchManifest('https://extra.example.com/m.json')).resolves.toMatchObject({
      resolvedUrl: 'https://extra.example.com/m.json',
    });
  });

  it('accepts the env-qualified sibling the bare asset host redirects to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(MANIFEST)),
    );
    await expect(
      makeLayers('brokkr.assets.example.com').fetchManifest('https://brokkr.assets.prod.example.com/m.json'),
    ).resolves.toMatchObject({ resolvedUrl: 'https://brokkr.assets.prod.example.com/m.json' });
  });

  it('follows the bare asset host through a redirect to its env sibling', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 302,
        headers: new Headers({ location: 'https://brokkr.assets.prod.example.com/m.json' }),
      })
      .mockResolvedValueOnce(okJson(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeLayers('brokkr.assets.example.com').fetchManifest('https://brokkr.assets.example.com/m.json'),
    ).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://brokkr.assets.prod.example.com/m.json');
  });

  it('rejects an unrecognised label in the env position', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeLayers('brokkr.assets.example.com').fetchManifest('https://brokkr.assets.evil.example.com/m'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-https URL without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').fetchManifest('http://assets.example.com/m')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unlisted host and names the host and the env knob', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').fetchManifest('https://evil.example.com/m')).rejects.toThrow(
      /evil\.example\.com[\s\S]*LAB_LAYERS_ALLOWED_HOSTS/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects any host when the allowlist is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('').fetchManifest('https://anything.example.com/m')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a release index to an allowlisted host and reports the followed URL', async () => {
    const followed = 'https://assets.example.com/os-layers/releases/v2/manifest.json';
    const fetchMock = vi.fn(async (u: string) => (u === followed ? okJson(MANIFEST) : okJson({ url: followed })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeLayers('assets.example.com').fetchManifest('https://assets.example.com/os-layers/releases/latest'),
    ).resolves.toEqual({ resolvedUrl: followed, doc: MANIFEST });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a release index pointing at a non-allowlisted host without fetching it', async () => {
    const evil = 'https://evil.example.com/manifest.json';
    const fetchMock = vi.fn(async () => okJson({ url: evil }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').fetchManifest('https://assets.example.com/index')).rejects.toThrow(
      /evil\.example\.com/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a body that does not match the manifest shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ nonsense: true })),
    );
    await expect(makeLayers('assets.example.com').fetchManifest('https://assets.example.com/m')).rejects.toThrow(
      /does not match the expected shape/,
    );
  });

  it('maps a fetch rejection to a 400 manifest-load-failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );
    await expect(makeLayers('assets.example.com').fetchManifest('https://assets.example.com/m')).rejects.toThrow(
      /manifest load failed/,
    );
  });

  it('maps a non-ok HTTP status to a 400 manifest-load-failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    await expect(makeLayers('assets.example.com').fetchManifest('https://assets.example.com/m')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('treats an empty-string url as absent and falls back to the default', async () => {
    const fetchMock = vi.fn(async () => okJson(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').fetchManifest('')).resolves.toMatchObject({
      resolvedUrl: 'https://assets.example.com/os-layers/releases/latest',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://assets.example.com/os-layers/releases/latest', expect.anything());
  });

  it('follows an http redirect between allowlisted hosts and returns the resolved body', async () => {
    const dest = 'https://assets.example.com/os-layers/releases/v9/manifest.json';
    const fetchMock = vi.fn(async (u: string) => (u === dest ? okJson(MANIFEST) : redirect(dest)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeLayers('assets.example.com').fetchManifest('https://assets.example.com/os-layers/releases/latest'),
    ).resolves.toMatchObject({ doc: MANIFEST });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an http redirect that points at a non-allowlisted host', async () => {
    const evil = 'https://evil.example.com/m';
    const fetchMock = vi.fn(async (u: string) => (u === evil ? okJson(MANIFEST) : redirect(evil)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').fetchManifest('https://assets.example.com/index')).rejects.toThrow(
      /evil\.example\.com/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects after exceeding the redirect hop cap', async () => {
    const fetchMock = vi.fn(async () => redirect('https://assets.example.com/next'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').fetchManifest('https://assets.example.com/start')).rejects.toThrow(
      /too many redirects/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('resolveManifestUrl returns the followed index url without shape-validating the final doc', async () => {
    const followed = 'https://assets.example.com/os-layers/releases/v3/manifest.json';
    const fetchMock = vi.fn(async (u: string) =>
      u === followed ? okJson({ nonsense: true }) : okJson({ url: followed }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeLayers('assets.example.com').resolveManifestUrl('https://assets.example.com/index')).resolves.toBe(
      followed,
    );
  });
});

describe('LayersService.seedManifest allowlist', () => {
  beforeEach(() => {
    vi.stubEnv('SIM_OS_LAYERS_MANIFEST_INDEX_URL', '');
    vi.stubEnv('LAB_LAYERS_ALLOWED_HOSTS', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects a disallowed URL before creating a run', () => {
    const runner = { create: vi.fn(), emit: vi.fn(), spawn: vi.fn(), finalize: vi.fn() };
    expect(() => makeLayers('assets.example.com', runner).seedManifest('https://evil.example.com/m')).toThrow(
      BadRequestException,
    );
    expect(runner.create).not.toHaveBeenCalled();
  });
});
