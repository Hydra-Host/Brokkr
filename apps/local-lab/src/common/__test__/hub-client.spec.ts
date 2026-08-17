import { afterEach, describe, expect, it, vi } from 'vitest';

import { hubApiFetch, hubApiSignIn } from '../hub-client';

function response(status: number, bodyText: string, setCookie: string[] = []) {
  return {
    status,
    headers: { getSetCookie: () => setCookie },
    text: () => Promise.resolve(bodyText),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('hubApiFetch', () => {
  it('round-trips the status code and JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, '{"hello":"world"}'))),
    );
    const res = await hubApiFetch('http://hub', new Map(), 'GET', '/x');
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('returns a null body for an empty response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(204, ''))),
    );
    const res = await hubApiFetch('http://hub', new Map(), 'GET', '/x');
    expect(res.code).toBe(204);
    expect(res.body).toBeNull();
  });
});

describe('hubApiSignIn', () => {
  it('throws the sign-in failure message when the sign-in call is non-200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(401, '{"error":"bad creds"}'))),
    );
    await expect(hubApiSignIn('http://hub')).rejects.toThrow('sign-in failed (401): {"error":"bad creds"}');
  });

  it('throws the set-active-org failure message when org selection is non-200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, '{"token":"t"}'))
      .mockResolvedValueOnce(response(500, '{"error":"no org"}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(hubApiSignIn('http://hub')).rejects.toThrow('set-active-org failed (500): {"error":"no org"}');
  });
});
