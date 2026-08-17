import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { getErrorMessage } from '../common/errors';
import { parseBoundary, RenderedConfigSchema } from '../common/pc-schemas';
import { SingleFlightCache } from '../common/single-flight-cache';
import { isPlainObject } from '../common/type-guards';
import { parseEnvEntries, stripQuoted } from './env-entries';
import { devenvRoot } from './paths';
import { ProcessComposeClient } from './process-compose.client';

const execFileP = promisify(execFile);

const DEPS_RETRY_COOLDOWN_MS = 30_000;

const INFRA_NAMESPACES = ['datastore', 'fleet'];
export const isServiceNamespace = (ns: string): boolean => ns.length > 0 && !INFRA_NAMESPACES.includes(ns);
export const isRollableService = (ns: string): boolean => isServiceNamespace(ns) && ns !== 'control';

export const datastoreIds = (catalog: Map<string, CatalogEntry>): string[] =>
  [...catalog].filter(([, c]) => c.namespace === 'datastore').map(([id]) => id);

// Per-process derivation from the rendered process-compose config: namespace→group, description→label,
// readiness-probe port (null for exec-probed datastores), disabled flag, and the LAB_WEB_UI web-UI descriptor.
export type CatalogEntry = {
  namespace: string;
  label: string;
  port: number | null;
  disabled: boolean;
  webUi?: { label: string; path: string; port: number; loopback: boolean };
};

export function resolveCatalog(
  name: string,
  catalog: Map<string, CatalogEntry>,
): { base: string; entry: CatalogEntry; replica: number } | null {
  const direct = catalog.get(name);
  if (direct) return { base: name, entry: direct, replica: 0 };
  const m = /^(.*)-(\d+)$/.exec(name);
  if (m) {
    const entry = catalog.get(m[1]);
    if (entry) return { base: m[1], entry, replica: Number(m[2]) };
  }
  return null;
}

/** LAB_WEB_PATH → a link path with a guaranteed leading slash ("" → "/", "grafana" → "/grafana"). */
function normalizeWebPath(raw: string | undefined): string {
  const path = raw || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/** LOCAL_FLEET_SOURCE (/nix/store …fleet.yml) + LOCAL_FLEET_PATH (…fleet.yaml) parsed from the rendered
 *  config's env entries — top-level + per-process; read/parse failure or ill-formed markers degrade to null. */
export function extractFleetPaths(cfgPath: string): { source: string; path: string } | null {
  let doc: unknown;
  try {
    doc = loadYaml(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    new Logger('extractFleetPaths').debug(`rendered config unreadable (${cfgPath}): ${getErrorMessage(e)}`);
    return null;
  }
  if (!isPlainObject(doc)) return null;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
  const candidates: string[] = [...strList(doc.environment)];
  const procs = isPlainObject(doc.processes) ? doc.processes : {};
  for (const spec of Object.values(procs)) {
    if (isPlainObject(spec)) candidates.push(...strList(spec.environment));
  }
  const env = new Map<string, string>();
  for (const [k, v] of parseEnvEntries(candidates)) env.set(k.trim(), stripQuoted(v));
  const source = env.get('LOCAL_FLEET_SOURCE');
  const path = env.get('LOCAL_FLEET_PATH');
  if (!source || !path) return null;
  if (!/^\/nix\/store\/[^\s"',]+fleet\.yml$/.test(source)) return null;
  if (!/^[^\s"',]+fleet\.yaml$/.test(path)) return null;
  return { source, path };
}

@Injectable()
export class RenderedConfigService implements OnModuleInit {
  private readonly log = new Logger(RenderedConfigService.name);

  private readonly devenvRoot = devenvRoot();

  // devenv build rendered-config path (full Nix eval); writeOverlay invalidates it, TTL backs out-of-band
  // edits, maxAttempts>1 forces a rebuild on a mid-build overlay write so callers never get a pre-overlay path.
  private readonly renderedConfigCache: SingleFlightCache<string>;
  // process→depends_on graph driving the `blocked` health state; degrades to "no deps" (never blocked)
  // on a read failure so a cold `devenv build` can't stall the status poll; applyOverlay invalidates it.
  private readonly dependsGraphCache: SingleFlightCache<Record<string, string[]>>;
  // {id → CatalogEntry} grouping source of truth; THROWS on a read failure (render paths degrade via
  // catalogOrEmpty, mutating ops must fail loudly); applyOverlay invalidates it.
  private readonly catalogCache: SingleFlightCache<Map<string, CatalogEntry>>;

  // armed by a mode-flip overlay write; the next rendered-config build inserts --refresh-eval-cache
  // (stack.local.nix is a conditional import the devenv eval cache doesn't track).
  private forceRefreshEval = false;

  constructor(private readonly pc: ProcessComposeClient) {
    this.renderedConfigCache = new SingleFlightCache<string>({
      load: () => this.loadRenderedConfigPath(),
      ttlMs: 30_000,
      maxAttempts: 3,
      staleMessage: 'rendered config kept changing under concurrent overlay writes — aborting to avoid stale snapshot',
    });
    this.dependsGraphCache = new SingleFlightCache<Record<string, string[]>>({
      load: () => this.loadDependsGraph(),
      cooldownMs: DEPS_RETRY_COOLDOWN_MS,
      degrade: () => ({}),
      onError: (e) =>
        this.log.warn(
          `depends-on graph unavailable (no blocked detection for ${DEPS_RETRY_COOLDOWN_MS / 1000}s): ${getErrorMessage(e)}`,
        ),
    });
    this.catalogCache = new SingleFlightCache<Map<string, CatalogEntry>>({
      load: () => this.loadCatalog(),
      cooldownMs: DEPS_RETRY_COOLDOWN_MS,
      cooldownMessage: 'process catalog unavailable — recent devenv build failure (cooling down)',
      onError: (e) =>
        this.log.warn(
          `catalog unavailable (render degrades to empty; no rebuild for ${DEPS_RETRY_COOLDOWN_MS / 1000}s): ${getErrorMessage(e)}`,
        ),
    });
  }

  onModuleInit(): void {
    void this.dependsGraph();
    void this.catalog().catch(() => {});
  }

  async dependsGraph(): Promise<Record<string, string[]>> {
    return this.dependsGraphCache.get();
  }

  /** The build+parse behind dependsGraph — throws on any read failure; the cache degrades that to an
   *  empty graph + a retry cooldown so a persistent failure stops re-spawning `devenv build` per poll. */
  private async loadDependsGraph(): Promise<Record<string, string[]>> {
    const cfgPath = await this.renderedConfigPath();
    const doc = parseBoundary(
      RenderedConfigSchema,
      loadYaml(readFileSync(cfgPath, 'utf8')),
      'rendered config (depends-on graph)',
    );
    const graph: Record<string, string[]> = {};
    for (const [name, p] of Object.entries(doc.processes ?? {})) graph[name] = Object.keys(p.depends_on ?? {});
    return graph;
  }

  /** Rendered process-compose config store path; `devenv build` re-evals the source and nix caches it,
   *  so a repeat build with no source change is a cheap store lookup. */
  async renderedConfigPath(): Promise<string> {
    return this.renderedConfigCache.get();
  }

  /** refreshEvalCache (explicit or the armed forceRefreshEval one-shot) inserts --refresh-eval-cache so a
   *  mode flip doesn't render a stale eval — stack.local.nix is a conditional import the eval cache misses. */
  private async loadRenderedConfigPath(opts: { refreshEvalCache?: boolean } = {}): Promise<string> {
    const refreshEvalCache = opts.refreshEvalCache || this.forceRefreshEval;
    this.forceRefreshEval = false;
    const args = [
      'build',
      ...(refreshEvalCache ? ['--refresh-eval-cache'] : []),
      'process.managers.process-compose.configFile',
    ];
    const { stdout } = await execFileP('devenv', args, {
      cwd: this.devenvRoot,
      timeout: 300_000,
    });
    const cfgPath = JSON.parse(stdout)['process.managers.process-compose.configFile'];
    if (typeof cfgPath !== 'string') throw new Error(`unexpected devenv build output: ${stdout.slice(0, 200)}`);
    return cfgPath;
  }

  /** Forced render for the fleet-apply/mode-flip paths: always builds now, and primes the cache so
   *  subsequent renderedConfigPath/catalog/deps reads serve the fresh path instead of a stale one. */
  async buildRenderedConfig(opts: { refreshEvalCache?: boolean } = {}): Promise<string> {
    return this.renderedConfigCache.prime(() => this.loadRenderedConfigPath(opts));
  }

  /** {id → CatalogEntry} for every process in the rendered pc config; also the offline roster source.
   *  THROWS on a read failure — render-only callers use catalogOrEmpty(); mutating ops must fail loudly. */
  async catalog(): Promise<Map<string, CatalogEntry>> {
    return this.catalogCache.get();
  }

  /** The build+parse behind catalog — throws on any read failure; the cache negatively-caches that for
   *  DEPS_RETRY_COOLDOWN_MS so a persistent failure doesn't re-spawn a build on every status poll. */
  private async loadCatalog(): Promise<Map<string, CatalogEntry>> {
    const cfgPath = await this.renderedConfigPath();
    const doc = parseBoundary(
      RenderedConfigSchema,
      loadYaml(readFileSync(cfgPath, 'utf8')),
      'rendered config (catalog)',
    );
    const out = new Map<string, CatalogEntry>();
    for (const [name, p] of Object.entries(doc.processes ?? {})) {
      const probePort = p.readiness_probe?.http_get?.port ?? null;
      // Port falls back to the readiness probe, so an exec-probed datastore UI (mailpit) must set LAB_WEB_PORT.
      const env = parseEnvEntries(p.environment ?? []);
      const uiLabel = env.get('LAB_WEB_UI');
      const webUi = uiLabel
        ? {
            label: uiLabel,
            path: normalizeWebPath(env.get('LAB_WEB_PATH')),
            port: Number(env.get('LAB_WEB_PORT')) || (probePort ?? 0),
            loopback: env.get('LAB_WEB_LOOPBACK') === 'true',
          }
        : undefined;
      out.set(name, {
        namespace: p.namespace ?? '',
        label: p.description ?? name,
        port: probePort,
        disabled: !!p.disabled,
        webUi,
      });
    }
    return out;
  }

  /** Degrades to an empty map — mutating ops must NOT use this. */
  async catalogOrEmpty(): Promise<Map<string, CatalogEntry>> {
    try {
      return await this.catalog();
    } catch {
      return new Map();
    }
  }

  async applyOverlay(cfgPath?: string): Promise<string | null> {
    cfgPath = cfgPath ?? (await this.renderedConfigPath());
    await this.pc.projectUpdate(cfgPath);
    this.renderedConfigCache.invalidate();
    // the config (depends_on graph + namespaces/labels, incl. a newly-added process) may have changed
    this.dependsGraphCache.invalidate();
    this.catalogCache.invalidate();
    this.log.log(`applied stack overlay (${cfgPath})`);
    return this.stageFleetYaml(cfgPath, { logSuccess: true, failMessage: 'fleet yaml refresh failed' });
  }

  async refreshFleetYaml(cfgPath?: string): Promise<string | null> {
    const resolved = cfgPath ?? (await this.buildRenderedConfig({ refreshEvalCache: true }).catch(() => null));
    if (!resolved) return null;
    return this.stageFleetYaml(resolved);
  }

  async renderDesiredFleetYaml(): Promise<string | null> {
    return this.stageFleetYaml(await this.renderedConfigPath().catch(() => undefined), {
      siblingName: 'fleet.desired.yaml',
    });
  }

  private stageFleetYaml(
    cfgPath: string | undefined,
    opts: { siblingName?: string | null; logSuccess?: boolean; failMessage?: string } = {},
  ): string | null {
    const { siblingName = null, logSuccess = false, failMessage = 'fleet yaml stage failed' } = opts;
    const fleet = cfgPath ? extractFleetPaths(cfgPath) : null;
    if (!fleet) return null;
    const src = fleet.source;
    const dst = siblingName ? join(dirname(fleet.path), siblingName) : fleet.path;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      const tmp = `${dst}.tmp`;
      // crash residue inherits the store's 0444 mode and would EACCES every retry's copy — clear it first
      rmSync(tmp, { force: true });
      copyFileSync(src, tmp);
      renameSync(tmp, dst);
      if (logSuccess) this.log.log(`fleet yaml refreshed (${src} → ${dst})`);
      return dst;
    } catch (e) {
      // Callers pass the returned path to spawned local.fleet processes — don't return one that doesn't reflect the seed.
      this.log.warn(`${failMessage}: ${(e as Error).message}`);
      return null;
    }
  }

  armRefreshEval(): void {
    this.forceRefreshEval = true;
  }

  invalidateRenderedConfig(): void {
    this.renderedConfigCache.invalidate();
  }
}
