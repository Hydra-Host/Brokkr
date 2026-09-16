import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLEAR = [
  'HUB_PUBLIC_HOST',
  'HUB_BROWSER_HOST',
  'LOOPBACK_HOST',
  'LAB_PORT',
  'LAB_WEB_PORT',
  'NGINX_PORT',
  'PG_PORT',
  'REDIS_PORT',
  'HUB_WEB_PORT',
  'THANOS_QUERY_HTTP_PORT',
  'HUB_API_PORT_BASE',
  'HUB_API_PORT_STEP',
  'SPOKE_PORT_BASE',
  'SPOKE_PORT_STEP',
  'SPOKE_GRPC_BASE',
  'SPOKE_GRPC_STEP',
];

const freshPorts = async () => {
  vi.resetModules();
  for (const k of CLEAR) vi.stubEnv(k, '');
  return import('../ports');
};

describe('primeNixPorts', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('adopts a flat port from the eval', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: 28888 });
    expect(PORTS.nginx).toBe(28888);
  });

  it('adopts a base and step pair from the eval', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ spoke: { base: 20500, step: 3 } });
    expect(PORTS.spoke).toEqual({ base: 20500, step: 3 });
  });

  it('maps the postgres eval key onto PORTS.pg', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ postgres: 25432 });
    expect(PORTS.pg).toBe(25432);
  });

  it('keeps the bootstrap port when the eval reports zero', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: 0 });
    expect(PORTS.nginx).toBe(8888);
  });

  it('keeps the bootstrap port when the eval reports a value above the tcp range', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: 65536 });
    expect(PORTS.nginx).toBe(8888);
  });

  it('keeps the bootstrap port when the eval reports a non-numeric value', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: 'eighty-eighty-eight' });
    expect(PORTS.nginx).toBe(8888);
  });

  it('adopts a port the eval reports as a numeric string', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: '28888' });
    expect(PORTS.nginx).toBe(28888);
  });

  it('keeps the bootstrap pair when the eval omits step', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ spoke: { base: 20500 } });
    expect(PORTS.spoke).toEqual({ base: 8000, step: 1 });
  });

  it('keeps the bootstrap pair when the pair base is out of the tcp range', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ spoke: { base: 0, step: 1 } });
    expect(PORTS.spoke).toEqual({ base: 8000, step: 1 });
  });

  it('keeps the bootstrap pair when the pair step is not an integer', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ spoke: { base: 20500, step: 1.5 } });
    expect(PORTS.spoke).toEqual({ base: 8000, step: 1 });
  });

  it('keeps the bootstrap pair when the eval reports null for a pair key', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ spoke: null });
    expect(PORTS.spoke).toEqual({ base: 8000, step: 1 });
  });

  it('lets a later prime replace an earlier value', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: 28888 });
    primeNixPorts({ nginx: 38888 });
    expect(PORTS.nginx).toBe(38888);
  });

  it('leaves an earlier value in place when a later prime omits the key', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: 28888 });
    primeNixPorts({ redis: 26379 });
    expect(PORTS.nginx).toBe(28888);
    expect(PORTS.redis).toBe(26379);
  });

  it('lets the environment outrank a primed eval value', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ nginx: 28888 });
    vi.stubEnv('NGINX_PORT', '39999');
    expect(PORTS.nginx).toBe(39999);
  });

  it('lets the environment outrank a primed pair, field by field', async () => {
    const { PORTS, primeNixPorts } = await freshPorts();
    primeNixPorts({ spoke: { base: 20500, step: 3 } });
    vi.stubEnv('SPOKE_PORT_BASE', '30500');
    expect(PORTS.spoke).toEqual({ base: 30500, step: 3 });
  });
  it('reports the count it adopted and names nothing when every value is usable', async () => {
    const { primeNixPorts } = await freshPorts();
    expect(primeNixPorts({ nginx: 28888, spoke: { base: 20500, step: 3 } })).toEqual({ adopted: 2, skipped: [] });
  });

  it('names every key it dropped, so a bad eval shape is not silent', async () => {
    const { primeNixPorts } = await freshPorts();
    expect(primeNixPorts({ nginx: 0, spoke: { base: 20500 }, redis: 26379 })).toEqual({
      adopted: 1,
      skipped: ['nginx', 'spoke'],
    });
  });
});

describe('URLS — the three audiences', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  const freshUrls = async (env: Record<string, string> = {}) => {
    vi.resetModules();
    for (const k of CLEAR) vi.stubEnv(k, '');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import('../ports');
    mod.primeNixPorts({ hubApi: { base: 3000, step: 2 }, hubWeb: 5173 });
    return mod;
  };

  it('dials loopback, never the public host, so a bind-address move cannot break a hub call', async () => {
    const { URLS } = await freshUrls({ HUB_BROWSER_HOST: '10.0.0.4' });

    expect(URLS.dial.hubApi).toBe('http://127.0.0.1:3000');
    expect(URLS.hubBase).toBe(URLS.dial.hubApi);
  });

  it('sends the browser audience to the host lan.bindAddress named', async () => {
    const { URLS } = await freshUrls({ HUB_BROWSER_HOST: '10.0.0.4' });

    expect(URLS.browser).toEqual({ hubApi: 'http://10.0.0.4:3000', hubWeb: 'http://10.0.0.4:5173' });
  });

  it('keeps the local audience on this box, so a developer url survives the host move', async () => {
    const { URLS } = await freshUrls({ HUB_BROWSER_HOST: '10.0.0.4' });

    expect(URLS.local.hubApi).toBe('http://localhost:3000');
  });

  it('falls back to the public host when only it declares a name', async () => {
    const { URLS } = await freshUrls({ HUB_PUBLIC_HOST: '10.0.0.9' });

    expect(URLS.browser.hubApi).toBe('http://10.0.0.9:3000');
  });

  it('falls back to localhost when neither host is declared', async () => {
    const { URLS } = await freshUrls();

    expect(URLS.browser.hubApi).toBe(URLS.local.hubApi);
  });
});
