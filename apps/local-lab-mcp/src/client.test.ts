import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLabContext,
  currentCheckout,
  resolveHostToken,
  resolveLabBaseUrl,
  resolveLabTarget,
  resolveLabToken,
} from './client.js';
import { selectStackTarget } from './target.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function registryDir(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-mcp-client-'));
  entries.forEach((entry, index) => writeFileSync(join(dir, `stack-${index}.json`), JSON.stringify(entry)));
  return dir;
}

function refusalMessage(dir: string): string {
  try {
    resolveLabBaseUrl(undefined, dir);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

function tokenFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lab-mcp-token-')), 'host-token');
  writeFileSync(path, contents);
  return path;
}

const emptyRegistry = () => registryDir([]);
const registryOwningCwd = (labPort: number) =>
  registryDir([
    { slot: 0, checkout: '/checkouts/someone-else', ports: { lab: 3002 } },
    { slot: 4, checkout: currentCheckout(), ports: { lab: labPort } },
  ]);

describe('resolveLabBaseUrl', () => {
  it('prefers the explicit value, then LAB_MCP_URL', () => {
    expect(resolveLabBaseUrl('http://explicit:1')).toBe('http://explicit:1');
    vi.stubEnv('LAB_MCP_URL', 'http://env:2');
    expect(resolveLabBaseUrl()).toBe('http://env:2');
    expect(resolveLabBaseUrl('http://explicit:1')).toBe('http://explicit:1');
  });

  it('falls back to the registry entry owning this checkout', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    expect(resolveLabBaseUrl(undefined, registryOwningCwd(21502))).toBe('http://127.0.0.1:21502');
  });

  it('throws naming this checkout and the checkouts that do own slots', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const message = refusalMessage(
      registryDir([
        { slot: 0, checkout: '/checkouts/someone-else', ports: { lab: 3002 } },
        { slot: 2, checkout: '/checkouts/another', ports: { lab: 21002 } },
      ]),
    );
    expect(message).toContain(currentCheckout());
    expect(message).toContain('slot 0  /checkouts/someone-else');
    expect(message).toContain('slot 2  /checkouts/another');
    expect(message).toContain('other clone');
    expect(message).toContain('lab_use_stack');
    expect(message).toContain('task up');
  });

  it('throws saying nothing is registered rather than printing an empty list', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const message = refusalMessage(emptyRegistry());
    expect(message).toContain(currentCheckout());
    expect(message).toContain('no stacks are registered on this host');
    expect(message).toContain('task up');
    expect(message).not.toContain('->');
  });
});

describe('resolveLabTarget', () => {
  it('marks this checkout its own slot, so nothing is announced', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const target = resolveLabTarget(undefined, registryOwningCwd(21502));
    expect(target).toEqual({
      baseUrl: 'http://127.0.0.1:21502',
      slot: 4,
      checkout: currentCheckout(),
      sameRepo: true,
      source: 'registry',
      own: true,
    });
  });

  it('reads LAB_MCP_SLOT after LAB_MCP_URL and before this checkout own entry', () => {
    const dir = registryOwningCwd(21502);
    vi.stubEnv('LAB_MCP_SLOT', '0');
    vi.stubEnv('LAB_MCP_URL', 'http://env:2');
    expect(resolveLabTarget(undefined, dir).source).toBe('env-url');
    vi.stubEnv('LAB_MCP_URL', undefined);
    const target = resolveLabTarget(undefined, dir);
    expect(target.source).toBe('env-slot');
    expect(target.baseUrl).toBe('http://127.0.0.1:3002');
    expect(target.own).toBe(false);
  });

  it('lets LAB_MCP_SLOT resolve for a checkout that owns nothing', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    vi.stubEnv('LAB_MCP_SLOT', '2');
    const dir = registryDir([{ slot: 2, checkout: '/checkouts/another', ports: { lab: 21002 } }]);
    expect(resolveLabTarget(undefined, dir).baseUrl).toBe('http://127.0.0.1:21002');
  });

  it('refuses when the entry owning this checkout records no lab port', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    vi.stubEnv('LAB_MCP_SLOT', undefined);
    const message = refusalMessage(registryDir([{ slot: 4, checkout: currentCheckout(), ports: {} }]));
    expect(message).toContain('owns no dev-stack slot');
    expect(message).toContain('lab_use_stack');
  });

  it('does not announce a pinned base url passed in directly', () => {
    expect(resolveLabTarget('http://explicit:1').own).toBe(true);
  });

  it('announces a base url pinned through LAB_MCP_URL, whose owner is unknown', () => {
    vi.stubEnv('LAB_MCP_URL', 'http://env:2');
    expect(resolveLabTarget()).toMatchObject({ source: 'env-url', own: false, slot: null, checkout: null });
  });
});

describe('currentCheckout', () => {
  it('is the repository toplevel of the working directory', () => {
    expect(currentCheckout()).toBe(process.cwd().replace(/\/apps\/local-lab-mcp$/, ''));
  });
});

describe('resolveLabToken', () => {
  it('prefers the explicit value, then LAB_API_TOKEN, then empty', () => {
    vi.stubEnv('LAB_API_TOKEN_FILE', undefined);
    expect(resolveLabToken('tok')).toBe('tok');
    vi.stubEnv('LAB_API_TOKEN', 'env-tok');
    expect(resolveLabToken()).toBe('env-tok');
    vi.stubEnv('LAB_API_TOKEN', '');
    expect(resolveLabToken()).toBe('');
  });

  it('reads LAB_API_TOKEN_FILE when no variable carries one, trimming the trailing newline', () => {
    vi.stubEnv('LAB_API_TOKEN', undefined);
    vi.stubEnv('LAB_API_TOKEN_FILE', tokenFile('  file-tok\n'));
    expect(resolveLabToken()).toBe('file-tok');
  });

  it('lets LAB_API_TOKEN outrank the file', () => {
    vi.stubEnv('LAB_API_TOKEN', 'env-tok');
    vi.stubEnv('LAB_API_TOKEN_FILE', tokenFile('file-tok'));
    expect(resolveLabToken()).toBe('env-tok');
  });

  it('lets an explicit value outrank both', () => {
    vi.stubEnv('LAB_API_TOKEN', 'env-tok');
    vi.stubEnv('LAB_API_TOKEN_FILE', tokenFile('file-tok'));
    expect(resolveLabToken('tok')).toBe('tok');
  });

  it('reads the file past an exported-but-empty LAB_API_TOKEN, which is not a token', () => {
    vi.stubEnv('LAB_API_TOKEN', '');
    vi.stubEnv('LAB_API_TOKEN_FILE', tokenFile('file-tok'));
    expect(resolveLabToken()).toBe('file-tok');
  });

  it('is empty when the pointed-at file does not exist, rather than throwing', () => {
    vi.stubEnv('LAB_API_TOKEN', undefined);
    vi.stubEnv('LAB_API_TOKEN_FILE', join(mkdtempSync(join(tmpdir(), 'lab-mcp-token-')), 'absent'));
    expect(resolveLabToken()).toBe('');
  });

  it('is empty when neither a variable nor a file is set', () => {
    vi.stubEnv('LAB_API_TOKEN', undefined);
    vi.stubEnv('LAB_API_TOKEN_FILE', undefined);
    expect(resolveLabToken()).toBe('');
  });
});

describe('resolveHostToken', () => {
  it('prefers the explicit value, then LAB_HOST_TOKEN, then its file', () => {
    vi.stubEnv('LAB_API_TOKEN', undefined);
    vi.stubEnv('LAB_API_TOKEN_FILE', undefined);
    expect(resolveHostToken('tok')).toBe('tok');
    vi.stubEnv('LAB_HOST_TOKEN', 'env-host');
    expect(resolveHostToken()).toBe('env-host');
    vi.stubEnv('LAB_HOST_TOKEN', undefined);
    vi.stubEnv('LAB_HOST_TOKEN_FILE', tokenFile('  file-host\n'));
    expect(resolveHostToken()).toBe('file-host');
  });

  it('falls back to the api token, so a loopback stack needs nothing set', () => {
    vi.stubEnv('LAB_HOST_TOKEN', undefined);
    vi.stubEnv('LAB_HOST_TOKEN_FILE', undefined);
    vi.stubEnv('LAB_API_TOKEN', 'api-tok');
    expect(resolveHostToken()).toBe('api-tok');
  });

  it('outranks the api token whenever a host token exists', () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-tok');
    vi.stubEnv('LAB_HOST_TOKEN', 'host-tok');
    expect(resolveHostToken()).toBe('host-tok');
  });

  it('reads its file past an exported-but-empty LAB_HOST_TOKEN', () => {
    vi.stubEnv('LAB_API_TOKEN', undefined);
    vi.stubEnv('LAB_API_TOKEN_FILE', undefined);
    vi.stubEnv('LAB_HOST_TOKEN', '');
    vi.stubEnv('LAB_HOST_TOKEN_FILE', tokenFile('file-host'));
    expect(resolveHostToken()).toBe('file-host');
  });

  it('is empty when nothing carries a token at all', () => {
    for (const v of ['LAB_HOST_TOKEN', 'LAB_HOST_TOKEN_FILE', 'LAB_API_TOKEN', 'LAB_API_TOKEN_FILE']) {
      vi.stubEnv(v, undefined);
    }
    expect(resolveHostToken()).toBe('');
  });
});

describe('createLabContext', () => {
  it('constructs without resolving, so an unresolvable stack only fails on use', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const ctx = createLabContext({ registryDir: emptyRegistry() });
    expect(() => ctx.client).toThrow(currentCheckout());
    expect(() => ctx.baseUrl).toThrow(currentCheckout());
  });

  it('picks up a stack that only appears after construction', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const ctx = createLabContext({ registryDir: registryOwningCwd(22002) });
    vi.stubEnv('LAB_MCP_URL', 'http://late:9');
    expect(ctx.baseUrl).toBe('http://late:9');
  });

  it('resolves the base URL once and reuses it', () => {
    vi.stubEnv('LAB_MCP_URL', 'http://first:1');
    const ctx = createLabContext();
    expect(ctx.baseUrl).toBe('http://first:1');
    vi.stubEnv('LAB_MCP_URL', 'http://second:2');
    expect(ctx.baseUrl).toBe('http://first:1');
  });

  it('setTarget overrides a base URL already resolved and memoized', () => {
    vi.stubEnv('LAB_MCP_URL', 'http://first:1');
    const ctx = createLabContext();
    expect(ctx.baseUrl).toBe('http://first:1');
    ctx.setTarget(selectStackTarget({ slot: 0 }, registryDir([{ slot: 0, checkout: '/c', ports: { lab: 3002 } }])));
    expect(ctx.baseUrl).toBe('http://127.0.0.1:3002');
    expect(ctx.target.slot).toBe(0);
  });

  it('setTarget outranks an explicit base URL, so the tool is never a silent no-op', () => {
    const ctx = createLabContext({ baseUrl: 'http://explicit:1' });
    expect(ctx.baseUrl).toBe('http://explicit:1');
    ctx.setTarget(selectStackTarget({ slot: 0 }, registryDir([{ slot: 0, checkout: '/c', ports: { lab: 3002 } }])));
    expect(ctx.baseUrl).toBe('http://127.0.0.1:3002');
  });

  it('setTarget rebuilds the client, so requests stop reaching the old stack', async () => {
    const seen: string[] = [];
    const api = async (args: { method: string; path: string }) => {
      seen.push(args.path);
      return { status: 200 as const, body: {}, headers: new Headers() };
    };
    vi.stubEnv('LAB_MCP_URL', 'http://first:1');
    const ctx = createLabContext({ api });
    await ctx.client.getStatus({});
    ctx.setTarget(selectStackTarget({ slot: 0 }, registryDir([{ slot: 0, checkout: '/c', ports: { lab: 3002 } }])));
    await ctx.client.getStatus({});
    expect(seen).toEqual(['http://first:1/api/status', 'http://127.0.0.1:3002/api/status']);
  });

  it('setTarget survives a checkout that owns no slot, which is the whole point', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const ctx = createLabContext({ registryDir: emptyRegistry() });
    expect(() => ctx.baseUrl).toThrow('owns no dev-stack slot');
    ctx.setTarget(selectStackTarget({ slot: 3 }, registryDir([{ slot: 3, checkout: '/c', ports: { lab: 21502 } }])));
    expect(ctx.baseUrl).toBe('http://127.0.0.1:21502');
  });

  it('reports no notice for its own slot and a notice for any other', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const ctx = createLabContext({ registryDir: registryOwningCwd(21502) });
    expect(ctx.targetNotice).toBeNull();
    expect(ctx.targetInfo).toMatchObject({ slot: 4, own: true, source: 'registry' });
    ctx.setTarget(
      selectStackTarget({ slot: 0 }, registryDir([{ slot: 0, checkout: '/checkouts/other', ports: { lab: 3002 } }])),
    );
    expect(ctx.targetNotice).toBe('[lab: slot 0 · /checkouts/other]');
    expect(ctx.targetInfo).toMatchObject({ slot: 0, own: false, source: 'tool' });
  });

  it('reports no notice and no info while the target cannot resolve', () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const ctx = createLabContext({ registryDir: emptyRegistry() });
    expect(ctx.targetNotice).toBeNull();
    expect(ctx.targetInfo).toBeNull();
  });

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

  it('sends the host token on the host client and the api token on the ordinary one', async () => {
    const seen: Record<string, string>[] = [];
    const api = async (args: { headers: Record<string, string> }) => {
      seen.push(args.headers);
      return { status: 200 as const, body: {}, headers: new Headers() };
    };
    const ctx = createLabContext({ baseUrl: 'http://lab.test', token: 'api-tok', hostToken: 'host-tok', api });
    await ctx.client.getStatus({});
    await ctx.hostClient.getStatus({});
    expect(seen[0]?.['x-lab-token']).toBe('api-tok');
    expect(seen[1]?.['x-lab-token']).toBe('host-tok');
  });

  it('retargets the host client too, so host-exec tools never keep hitting the old stack', async () => {
    const seen: string[] = [];
    const api = async (args: { path: string }) => {
      seen.push(args.path);
      return { status: 200 as const, body: {}, headers: new Headers() };
    };
    vi.stubEnv('LAB_MCP_URL', 'http://first:1');
    const ctx = createLabContext({ api, hostToken: 'host-tok' });
    await ctx.hostClient.getStatus({});
    ctx.setTarget(selectStackTarget({ slot: 0 }, registryDir([{ slot: 0, checkout: '/c', ports: { lab: 3002 } }])));
    await ctx.hostClient.getStatus({});
    expect(seen).toEqual(['http://first:1/api/status', 'http://127.0.0.1:3002/api/status']);
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
