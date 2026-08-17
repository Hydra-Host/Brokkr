import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLabContext, resolveLabBaseUrl, resolveLabToken } from './client.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveLabBaseUrl', () => {
  it('prefers the explicit value, then LAB_MCP_URL, then the default', () => {
    expect(resolveLabBaseUrl('http://explicit:1')).toBe('http://explicit:1');
    vi.stubEnv('LAB_MCP_URL', 'http://env:2');
    expect(resolveLabBaseUrl()).toBe('http://env:2');
    expect(resolveLabBaseUrl('http://explicit:1')).toBe('http://explicit:1');
  });

  it('falls back to the loopback default when nothing is set', () => {
    vi.stubEnv('LAB_MCP_URL', '');
    expect(resolveLabBaseUrl()).toBe('http://127.0.0.1:3002');
  });
});

describe('resolveLabToken', () => {
  it('prefers the explicit value, then LAB_API_TOKEN, then empty', () => {
    expect(resolveLabToken('tok')).toBe('tok');
    vi.stubEnv('LAB_API_TOKEN', 'env-tok');
    expect(resolveLabToken()).toBe('env-tok');
    vi.stubEnv('LAB_API_TOKEN', '');
    expect(resolveLabToken()).toBe('');
  });
});

describe('createLabContext', () => {
  it('builds a client that routes requests through the injected api fetcher', async () => {
    const seen: string[] = [];
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: async (args) => {
        seen.push(`${args.method} ${args.path}`);
        return { status: 200, body: { ok: true }, headers: new Headers() };
      },
    });
    const res = await ctx.client.getStatus({});
    expect(res.status).toBe(200);
    expect(seen).toEqual(['GET http://lab.test/api/status']);
  });

  it('sends the x-lab-token header only when a token is set', async () => {
    const seen: Record<string, string>[] = [];
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      token: 'secret',
      api: async (args) => {
        seen.push(args.headers);
        return { status: 200, body: {}, headers: new Headers() };
      },
    });
    await ctx.client.getStatus({});
    expect(seen[0]?.['x-lab-token']).toBe('secret');
  });

  it('omits the x-lab-token header when no token is set', async () => {
    const seen: Record<string, string>[] = [];
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      token: '',
      api: async (args) => {
        seen.push(args.headers);
        return { status: 200, body: {}, headers: new Headers() };
      },
    });
    await ctx.client.getStatus({});
    expect(seen[0]?.['x-lab-token']).toBeUndefined();
  });
});
