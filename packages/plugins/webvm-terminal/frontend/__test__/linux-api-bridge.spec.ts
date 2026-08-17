import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatApiOutput, makeApiRequest, normalizeApiPath } from '../linux-api-bridge';

describe('normalizeApiPath', () => {
  it('keeps already-correct /api/v1 paths', () => {
    expect(normalizeApiPath('/api/v1/devices')).toBe('/api/v1/devices');
    expect(normalizeApiPath('/api/v1')).toBe('/api/v1');
  });

  it('rewrites bare /api/ paths onto /api/v1', () => {
    expect(normalizeApiPath('/api/devices')).toBe('/api/v1/devices');
    expect(normalizeApiPath('/api/v2/devices')).toBe('/api/v1/v2/devices');
  });

  it('prefixes bare paths, with or without a leading slash', () => {
    expect(normalizeApiPath('/devices')).toBe('/api/v1/devices');
    expect(normalizeApiPath('devices')).toBe('/api/v1/devices');
  });

  it('preserves query strings', () => {
    expect(normalizeApiPath('/api/v1/devices?page=2&status=live')).toBe('/api/v1/devices?page=2&status=live');
    expect(normalizeApiPath('devices?page=2')).toBe('/api/v1/devices?page=2');
  });

  it('resolves .. traversal so the result cannot escape /api/v1', () => {
    expect(normalizeApiPath('../../admin')).toBe('/api/v1/admin');
    expect(normalizeApiPath('/api/v1/../../admin')).toBe('/api/v1/admin');
    expect(normalizeApiPath('/api/../admin')).toBe('/api/v1/admin');
    expect(normalizeApiPath('/devices/../../../etc')).toBe('/api/v1/etc');
  });

  it('neutralizes protocol-relative targets', () => {
    expect(normalizeApiPath('//evil.example/steal')).toBe('/api/v1/steal');
  });

  it.each([
    '/api/v1/devices',
    '/api/devices',
    'devices',
    '../../admin',
    '/api/v1/../../../x',
    '//host/x',
    './a/./b/../c',
  ])('always yields a path under /api/v1 (%s)', (input) => {
    const out = normalizeApiPath(input);
    const finalPath = new URL(out, 'https://origin.invalid').pathname;
    expect(finalPath === '/api/v1' || finalPath.startsWith('/api/v1/')).toBe(true);
  });
});

describe('makeApiRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (status = 200, body = '{"ok":true}') => {
    const fetchMock = vi.fn().mockResolvedValue({ status, text: () => Promise.resolve(body) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('performs the request against the normalized path with credentials', async () => {
    const fetchMock = stubFetch();
    const result = await makeApiRequest(JSON.stringify({ method: 'get', url: 'devices?page=2' }));
    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/devices?page=2',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('merges caller headers over the JSON default', async () => {
    const fetchMock = stubFetch();
    await makeApiRequest(
      JSON.stringify({ method: 'post', url: '/things', body: { a: 1 }, headers: { 'X-Extra': 'y' } }),
    );
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers).toEqual({ 'Content-Type': 'application/json', 'X-Extra': 'y' });
    expect(options.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('drops the body for GET and HEAD', async () => {
    const fetchMock = stubFetch();
    await makeApiRequest(JSON.stringify({ method: 'GET', url: '/things', body: { a: 1 } }));
    await makeApiRequest(JSON.stringify({ method: 'head', url: '/things', body: 'x' }));
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  });

  it('passes string bodies through without re-encoding', async () => {
    const fetchMock = stubFetch();
    await makeApiRequest(JSON.stringify({ method: 'PUT', url: '/things', body: '{"raw":1}' }));
    expect(fetchMock.mock.calls[0][1].body).toBe('{"raw":1}');
  });

  it('returns a 500 envelope for malformed request JSON', async () => {
    const fetchMock = stubFetch();
    const result = await makeApiRequest('not json at all');
    expect(result.status).toBe(500);
    expect(() => JSON.parse(result.body)).not.toThrow();
    expect(JSON.parse(result.body)).toHaveProperty('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a 500 envelope when the request itself has no method', async () => {
    stubFetch();
    const result = await makeApiRequest(JSON.stringify({ url: '/things' }));
    expect(result.status).toBe(500);
    expect(JSON.parse(result.body)).toHaveProperty('error');
  });

  it('returns a 500 envelope when fetch rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await makeApiRequest(JSON.stringify({ method: 'GET', url: '/things' }));
    expect(result).toEqual({ status: 500, body: JSON.stringify({ error: 'offline' }) });
  });
});

describe('formatApiOutput', () => {
  it('marks 2xx green with a check and pretty-prints JSON bodies', () => {
    const out = formatApiOutput(200, '{"a":1}');
    expect(out).toContain('\x1b[32m✓ HTTP 200');
    expect(out).toContain('{\n  "a": 1\n}');
  });

  it('marks non-2xx red with a cross', () => {
    const out = formatApiOutput(404, '{"message":"nope"}');
    expect(out).toContain('\x1b[31m✗ HTTP 404');
  });

  it('passes non-JSON bodies through untouched', () => {
    expect(formatApiOutput(200, 'plain text')).toContain('plain text');
  });
});
