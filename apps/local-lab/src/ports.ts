/** Mirror of `modules/ports.nix` (the Nix SSOT) — the DEFAULTS only apply standalone and must be kept in sync by hand. */

const DEFAULT_PORTS = {
  lab: 3002,
  labWeb: 5175,
  hubApi: { base: 3000, step: 2 },
  hubWeb: 5173,
  spoke: { base: 8000, step: 1 },
  spokeGrpc: { base: 9082, step: 1 },
  nginx: 8888,
  pg: 5432,
  redis: 6379,
  thanosQueryHttp: 10903,
};

const DEFAULT_HOSTS = {
  hubPublic: 'localhost',
  dataPlaneGateway: '192.168.200.1',
  loopback: '127.0.0.1',
};

const envNum = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const envStr = (v: string | undefined, d: string): string => v || d;

// this stack's multi-stack slot (modules/ports.nix labPortEnv); standalone falls back to the legacy slot 0
export const STACK_SLOT = envNum(process.env.STACK_SLOT, 0);

export const PORTS = {
  lab: envNum(process.env.LAB_PORT, DEFAULT_PORTS.lab),
  labWeb: envNum(process.env.LAB_WEB_PORT, DEFAULT_PORTS.labWeb),
  hubApi: {
    base: envNum(process.env.HUB_API_PORT_BASE, DEFAULT_PORTS.hubApi.base),
    step: envNum(process.env.HUB_API_PORT_STEP, DEFAULT_PORTS.hubApi.step),
  },
  hubWeb: envNum(process.env.HUB_WEB_PORT, DEFAULT_PORTS.hubWeb),
  spoke: {
    base: envNum(process.env.SPOKE_PORT_BASE, DEFAULT_PORTS.spoke.base),
    step: envNum(process.env.SPOKE_PORT_STEP, DEFAULT_PORTS.spoke.step),
  },
  spokeGrpc: {
    base: envNum(process.env.SPOKE_GRPC_BASE, DEFAULT_PORTS.spokeGrpc.base),
    step: envNum(process.env.SPOKE_GRPC_STEP, DEFAULT_PORTS.spokeGrpc.step),
  },
  nginx: envNum(process.env.NGINX_PORT, DEFAULT_PORTS.nginx),
  pg: envNum(process.env.PG_PORT, DEFAULT_PORTS.pg),
  redis: envNum(process.env.REDIS_PORT, DEFAULT_PORTS.redis),
  thanosQueryHttp: envNum(process.env.THANOS_QUERY_HTTP_PORT, DEFAULT_PORTS.thanosQueryHttp),
} as const;

export const HOSTS = {
  hubPublic: envStr(process.env.HUB_PUBLIC_HOST, DEFAULT_HOSTS.hubPublic),
  dataPlaneGateway: envStr(process.env.DATA_PLANE_GATEWAY, DEFAULT_HOSTS.dataPlaneGateway),
  loopback: envStr(process.env.LOOPBACK_HOST, DEFAULT_HOSTS.loopback),
  assetOrigin: envStr(process.env.ASSET_ORIGIN, ''),
} as const;

/** Same shape as modules/ports.nix `mkPgUrlRaw`, so a DSN derived from a control-center identity edit
 *  matches the one the hub will be launched with. */
export const mkPgUrl = (pg: { user: string; password: string; db: string }, port: number = PORTS.pg): string =>
  `postgresql://${pg.user}:${pg.password}@${HOSTS.loopback}:${port}/${pg.db}`;

export const URLS = {
  pg: mkPgUrl({ user: 'brokkr', password: 'password', db: 'brokkr' }),
  redis: `redis://${HOSTS.loopback}:${PORTS.redis}`,
  thanosQuery: `http://${HOSTS.loopback}:${PORTS.thanosQueryHttp}`,
  hubBase: `http://${HOSTS.hubPublic}:${PORTS.hubApi.base}`,
  osLayer: `http://${HOSTS.dataPlaneGateway}:${PORTS.nginx}/assets`,
} as const;

// shared hub-DSN resolution for PgService + the db stack ops — prisma.config.ts defaults to
// postgres/postgres, so ops shelling out to prisma must inject this resolved URL explicitly.
export const resolvePgUrl = (): string => process.env.DATASTORE_PG_URL || process.env.HUB_DATABASE_URL || URLS.pg;
