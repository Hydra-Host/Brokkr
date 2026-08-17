import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchLabText } from './fetch-lab-text';

describe('fetchLabText', () => {
  beforeEach(() => {
    const store = new Map<string, string>([['lab-api-token', 'sekret']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the lab token header and returns the body text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('log output') });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLabText('/api/tests/runs/r1/attachment?source=hub')).resolves.toBe('log output');
    expect(fetchMock).toHaveBeenCalledWith('/api/tests/runs/r1/attachment?source=hub', {
      headers: { 'x-lab-token': 'sekret' },
    });
  });

  it('rejects on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('nope') }));
    await expect(fetchLabText('/api/tests/runs/x/attachment?source=missing')).rejects.toThrow('request failed (404)');
  });
});
