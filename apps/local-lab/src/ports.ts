/** Bootstrap only: what a port resolves to before the first `devenv eval` can answer. `main.ts` binds
 *  the lab listener at boot, so these cannot wait on the seed. */
const BOOTSTRAP_PORTS = {
  lab: 3002,
  labWeb: 5175,
  hubApi: { base: 3000, step: 2 },
  hubWeb: 5173,
  spoke: { base: 8000, step: 1 },
  spokeGrpc: { base: 9082, step: 1 },
  nginx: 8888,
  postgres: 5432,
  redis: 6379,
  thanosQueryHttp: 10903,
};

// hosts are deliberately not overridable in Nix (modules/overrides.nix), so no eval reports them —
// except the browser-facing host, which follows lan.bindAddress and arrives as HUB_BROWSER_HOST.
const DEFAULT_HOSTS = {
  hubPublic: 'localhost',
  dataPlaneGateway: '192.168.200.1',
  loopback: '127.0.0.1',
};

const nixPorts: Record<string, number> = {};
const nixPortPairs: Record<string, { base: number; step: number }> = {};

const isTcpPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;
const isPair = (v: unknown): v is { base: unknown; step: unknown } =>
  typeof v === 'object' && v !== null && 'base' in v && 'step' in v;

/** Adopt the effective ports the overlay store read from `devenv eval ports`, so a slot move or a
 *  modules/ports.nix change reaches this process without a second copy of the map. */
export const primeNixPorts = (raw: Record<string, unknown>): { adopted: number; skipped: string[] } => {
  let adopted = 0;
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const flat = Number(value);
    if (isTcpPort(flat)) {
      nixPorts[key] = flat;
      adopted += 1;
      continue;
    }
    if (isPair(value)) {
      const base = Number(value.base);
      const step = Number(value.step);
      if (isTcpPort(base) && Number.isInteger(step)) {
        nixPortPairs[key] = { base, step };
        adopted += 1;
        continue;
      }
    }
    skipped.push(key);
  }
  return { adopted, skipped };
};

const envNum = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : d);

// env wins (the stack splices the effective port into this process), then the eval, then the bootstrap.
const port = (env: string | undefined, key: string, bootstrap: number): number =>
  envNum(env, nixPorts[key] ?? bootstrap);

const portPair = (
  baseEnv: string | undefined,
  stepEnv: string | undefined,
  key: string,
  bootstrap: { base: number; step: number },
): { base: number; step: number } => ({
  base: envNum(baseEnv, nixPortPairs[key]?.base ?? bootstrap.base),
  step: envNum(stepEnv, nixPortPairs[key]?.step ?? bootstrap.step),
});

const envStr = (v: string | undefined, d: string): string => v || d;

// this stack's multi-stack slot (modules/ports.nix labPortEnv); standalone falls back to the legacy slot 0
export const STACK_SLOT = envNum(process.env.STACK_SLOT, 0);

export const PORTS = {
  get lab() {
    return port(process.env.LAB_PORT, 'lab', BOOTSTRAP_PORTS.lab);
  },
  get labWeb() {
    return port(process.env.LAB_WEB_PORT, 'labWeb', BOOTSTRAP_PORTS.labWeb);
  },
  get hubApi() {
    return portPair(process.env.HUB_API_PORT_BASE, process.env.HUB_API_PORT_STEP, 'hubApi', BOOTSTRAP_PORTS.hubApi);
  },
  get hubWeb() {
    return port(process.env.HUB_WEB_PORT, 'hubWeb', BOOTSTRAP_PORTS.hubWeb);
  },
  get spoke() {
    return portPair(process.env.SPOKE_PORT_BASE, process.env.SPOKE_PORT_STEP, 'spoke', BOOTSTRAP_PORTS.spoke);
  },
  get spokeGrpc() {
    return portPair(process.env.SPOKE_GRPC_BASE, process.env.SPOKE_GRPC_STEP, 'spokeGrpc', BOOTSTRAP_PORTS.spokeGrpc);
  },
  get nginx() {
    return port(process.env.NGINX_PORT, 'nginx', BOOTSTRAP_PORTS.nginx);
  },
  get pg() {
    return port(process.env.PG_PORT, 'postgres', BOOTSTRAP_PORTS.postgres);
  },
  get redis() {
    return port(process.env.REDIS_PORT, 'redis', BOOTSTRAP_PORTS.redis);
  },
  get thanosQueryHttp() {
    return port(process.env.THANOS_QUERY_HTTP_PORT, 'thanosQueryHttp', BOOTSTRAP_PORTS.thanosQueryHttp);
  },
};

export const HOSTS = {
  hubPublic: envStr(process.env.HUB_PUBLIC_HOST, DEFAULT_HOSTS.hubPublic),
  hubBrowser: envStr(process.env.HUB_BROWSER_HOST, envStr(process.env.HUB_PUBLIC_HOST, DEFAULT_HOSTS.hubPublic)),
  dataPlaneGateway: envStr(process.env.DATA_PLANE_GATEWAY, DEFAULT_HOSTS.dataPlaneGateway),
  loopback: envStr(process.env.LOOPBACK_HOST, DEFAULT_HOSTS.loopback),
  assetOrigin: envStr(process.env.ASSET_ORIGIN, ''),
} as const;

/** Same shape as modules/ports.nix `mkPgUrlRaw`, so a DSN derived from a control-center identity edit
 *  matches the one the hub will be launched with. */
export const mkPgUrl = (pg: { user: string; password: string; db: string }, port: number = PORTS.pg): string =>
  `postgresql://${pg.user}:${pg.password}@${HOSTS.loopback}:${port}/${pg.db}`;

export type HubOrigins = { hubApi: string; hubWeb: string };

/** modules/ports.nix `originsFor`. http only — this repo terminates no TLS and mints no certificate,
 *  which is why the Nix side hardcodes `publicScheme` too. */
const originsFor = (host: string): HubOrigins => ({
  hubApi: `http://${host}:${PORTS.hubApi.base}`,
  hubWeb: `http://${host}:${PORTS.hubWeb}`,
});

export const URLS = {
  get pg() {
    return mkPgUrl({ user: 'brokkr', password: 'password', db: 'brokkr' });
  },
  get redis() {
    return `redis://${HOSTS.loopback}:${PORTS.redis}`;
  },
  get thanosQuery() {
    return `http://${HOSTS.loopback}:${PORTS.thanosQueryHttp}`;
  },
  /** What a person types and what better-auth must trust. Follows lan.bindAddress. */
  get browser() {
    return originsFor(HOSTS.hubBrowser);
  },
  /** The same surfaces from this box, so a developer's own http://localhost:… survives a host move. */
  get local() {
    return originsFor(HOSTS.hubPublic);
  },
  /** Server-to-server on this host. Every dial-out from the lab process belongs here. */
  get dial() {
    return originsFor(HOSTS.loopback);
  },
  /** @deprecated Name the audience: `URLS.dial.hubApi` for a dial-out, `URLS.browser.hubApi` for a link. */
  get hubBase() {
    return this.dial.hubApi;
  },
  get osLayer() {
    return `http://${HOSTS.dataPlaneGateway}:${PORTS.nginx}/assets`;
  },
};

// shared hub-DSN resolution for PgService + the db stack ops — prisma.config.ts defaults to
// postgres/postgres, so ops shelling out to prisma must inject this resolved URL explicitly.
export const resolvePgUrl = (): string => process.env.DATASTORE_PG_URL || process.env.HUB_DATABASE_URL || URLS.pg;
