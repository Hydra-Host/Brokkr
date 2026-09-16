import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { getErrorMessage, isRecord } from '@repo/utils';
import { parseBoundary, RenderedConfigSchema } from '../common/pc-schemas';
import { SingleFlightCache } from '../common/single-flight-cache';
import { APPLY_SCOPE_ALL, describeApplyScope, inApplyScope, type ApplyScope } from './apply-scope';
import { parseEnvEntries, stripQuoted } from './env-entries';
import { specMatchesRunning, swapDiffSet } from './mode-drift';
import { devenvRoot } from './paths';
import { ProcessComposeClient, type PcProcessConfig } from './process-compose.client';

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
  features?: string[];
};

export const SERVICE_FEATURE_FLAGS: ReadonlyArray<{ env: string; label: string }> = [
  { env: 'TFTP_ENABLED', label: 'TFTP' },
  { env: 'BRIDGE_IPXE_BUILDS_STRICT', label: 'iPXE strict' },
];

export const featuresFromEnv = (env: ReadonlyMap<string, string>): string[] =>
  SERVICE_FEATURE_FLAGS.filter((f) => (env.get(f.env) ?? '').toLowerCase() === 'true').map((f) => f.label);

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
  if (!isRecord(doc)) return null;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
  const candidates: string[] = [...strList(doc.environment)];
  const procs = isRecord(doc.processes) ? doc.processes : {};
  for (const spec of Object.values(procs)) {
    if (isRecord(spec)) candidates.push(...strList(spec.environment));
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

/** One reused path, never a per-apply mkdtemp: the submitted config carries every process's fully
 *  resolved environment (datastore DSNs included) and must not accumulate in the system temp dir. */
function overlayConfigPath(): string {
  const state = process.env.DEVENV_STATE;
  return join(state ? join(state, 'lab') : tmpdir(), 'overlay-process-compose.yaml');
}

function submittedProcessNames(cfgPath: string): Set<string> {
  const doc = loadYaml(readFileSync(cfgPath, 'utf8'));
  if (!isRecord(doc) || !isRecord(doc.processes)) return new Set();
  return new Set(Object.keys(doc.processes));
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

  // One apply at a time: the submitted config is a single reused path, so two concurrent applies
  // would let one validate its own file and then hand projectUpdate the other's.
  private applyLock: Promise<void> = Promise.resolve();

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
        features: featuresFromEnv(env),
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

  /** `scope` names what this apply may recreate: `project update` recreates every process whose
   *  spec moved, and the global --task-file hash moves all of them at once. */
  async applyOverlay(cfgPath?: string, scope: ApplyScope = APPLY_SCOPE_ALL): Promise<string | null> {
    const prior = this.applyLock;
    let release!: () => void;
    this.applyLock = new Promise<void>((resolve) => (release = resolve));
    await prior;
    try {
      return await this.applyOverlayLocked(cfgPath, scope);
    } finally {
      release();
    }
  }

  private async applyOverlayLocked(cfgPath: string | undefined, scope: ApplyScope): Promise<string | null> {
    const rendered = cfgPath ?? (await this.renderedConfigPath());
    const { path, namespaces } = await this.pinOutOfScope(rendered, scope);
    await this.refuseSwapBeyondScope(path, scope, namespaces);
    await this.refusePinGap(path, scope);
    await this.pc.projectUpdate(path);
    this.renderedConfigCache.invalidate();
    // the config (depends_on graph + namespaces/labels, incl. a process this apply adds — which the
    // supervisor supervises but cannot start, its task list being fixed at bring-up) may have changed
    this.dependsGraphCache.invalidate();
    this.catalogCache.invalidate();
    this.log.log(`applied stack overlay (${path}) scoped to ${describeApplyScope(scope)}`);
    // the rendered config, never the pinned one: LOCAL_FLEET_SOURCE lives on the out-of-scope fleet
    // process, so staging from the pin would copy the running topology back over a newer one
    return this.stageFleetYaml(rendered, { logSuccess: true, failMessage: 'fleet yaml refresh failed' });
  }

  /** Returns the config to submit and the namespace of every process it may recreate OR delete —
   *  a render that drops a supervised process is judged too, not passed over unseen. */
  private async pinOutOfScope(
    cfgPath: string,
    scope: ApplyScope,
  ): Promise<{ path: string; namespaces: Map<string, string> }> {
    const doc = loadYaml(readFileSync(cfgPath, 'utf8'));
    const namespaces = new Map<string, string>();
    if (!isRecord(doc) || !isRecord(doc.processes))
      throw new Error(`overlay apply refused: ${cfgPath} declares no processes map`);
    const processes = doc.processes;
    const supervised = new Set((await this.pc.listAll()).map((p) => p.name));
    // Nothing supervised while the render declares processes is a failed read, not an empty stack.
    // Pinning would then cover nothing and the raw render would recreate every process that moved.
    if (supervised.size === 0 && Object.keys(processes).length > 0)
      throw new Error(
        'overlay apply refused: process-compose reported no supervised processes — retry once it answers',
      );
    const pinned: string[] = [];
    const revived: string[] = [];
    for (const name of new Set([...Object.keys(processes), ...supervised])) {
      const spec = processes[name];
      if (isRecord(spec)) {
        const namespace = typeof spec.namespace === 'string' ? spec.namespace : '';
        namespaces.set(name, namespace);
        // a process the daemon does not run yet has no spec to preserve, and recreating it kills nothing
        if (!supervised.has(name) || inApplyScope(scope, name, namespace)) continue;
        const { info, command } = await this.runningSpec(name, scope);
        // only the fields the daemon reports in their rendered form: its depends_on carries the
        // condition as an enum int, and its probes/availability come back normalized
        spec.command = command;
        spec.environment = info.environment ?? [];
        if (info.disabled === true) spec.disabled = true;
        else delete spec.disabled;
        pinned.push(name);
        continue;
      }
      if (!supervised.has(name)) continue;
      const { info, command } = await this.runningSpec(name, scope);
      const namespace = typeof info.namespace === 'string' ? info.namespace : '';
      namespaces.set(name, namespace);
      // dropping an in-scope process is the legitimate removal this apply is allowed to make
      if (inApplyScope(scope, name, namespace)) continue;
      processes[name] = this.reviveDropped(name, info, command, scope);
      revived.push(name);
    }
    const covered = new Set([...pinned, ...revived]);
    const missed = [...supervised].filter((n) => !inApplyScope(scope, n, namespaces.get(n) ?? '') && !covered.has(n));
    if (missed.length > 0) throw new Error(`overlay apply refused: the pin did not cover ${missed.join(', ')}`);
    if (pinned.length === 0 && revived.length === 0) {
      this.log.log(`overlay scoped to ${describeApplyScope(scope)}: nothing out of scope to pin`);
      return { path: cfgPath, namespaces };
    }
    const path = overlayConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    // tmp+rename like stageFleetYaml: a partial write here is what lastAppliedSpec reads to revive a
    // dropped process, so a crash mid-write would block the next apply until the file is deleted.
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, dumpYaml(doc, { lineWidth: -1, noRefs: true }), { mode: 0o600 });
    renameSync(tmp, path);
    this.log.log(
      `overlay scoped to ${describeApplyScope(scope)}: pinned ${pinned.length} process(es) to their running spec` +
        (revived.length > 0 ? `, kept ${revived.join(', ')} the render no longer declares` : ''),
    );
    return { path, namespaces };
  }

  /** Both failures are refusals: the alternative is submitting a config that recreates or deletes it. */
  private async runningSpec(name: string, scope: ApplyScope): Promise<{ info: PcProcessConfig; command: string }> {
    let info: PcProcessConfig;
    try {
      info = await this.pc.processInfo(name);
    } catch (e) {
      throw new Error(
        `cannot read the running spec of ${name} (${getErrorMessage(e)}) — refusing an apply that would recreate it outside the ${describeApplyScope(scope)} scope`,
      );
    }
    const command = info.command;
    if (!command)
      throw new Error(
        `${name} reports no running command — refusing an apply that would recreate it outside the ${describeApplyScope(scope)} scope`,
      );
    return { info, command };
  }

  /** Re-declares a dropped process from the config the last apply submitted: the daemon reports
   *  readiness_probe/availability/shutdown normalized, so its own report cannot restore them. */
  private reviveDropped(
    name: string,
    info: PcProcessConfig,
    command: string,
    scope: ApplyScope,
  ): Record<string, unknown> {
    if (Object.keys(info.dependsOn ?? {}).length > 0)
      throw new Error(
        `${name} is running with depends_on the rendered config no longer declares — refusing an apply that would delete it outside the ${describeApplyScope(scope)} scope`,
      );
    const previous = this.lastAppliedSpec(name, info);
    if (!previous)
      throw new Error(
        `${name} is running but the rendered config no longer declares it, and ${overlayConfigPath()} holds no spec that still matches it — refusing an apply that would either delete it or revive it without its health gate, outside the ${describeApplyScope(scope)} scope`,
      );
    const spec: Record<string, unknown> = { ...previous, command, environment: info.environment ?? [] };
    if (info.disabled === true) spec.disabled = true;
    else delete spec.disabled;
    return spec;
  }

  /** The spec the last overlay apply submitted for `name`, in rendered-yaml form. Null when that
   *  config is absent, silent about the process, or no longer describes what the daemon runs. */
  private lastAppliedSpec(name: string, info: PcProcessConfig): Record<string, unknown> | null {
    const path = overlayConfigPath();
    let doc: unknown;
    try {
      doc = loadYaml(readFileSync(path, 'utf8'));
    } catch (e) {
      this.log.debug(`no previously applied config for ${name} (${path}): ${getErrorMessage(e)}`);
      return null;
    }
    if (!isRecord(doc) || !isRecord(doc.processes)) return null;
    const spec = doc.processes[name];
    if (!isRecord(spec)) return null;
    const strList = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
    const matches = specMatchesRunning(
      {
        command: typeof spec.command === 'string' ? spec.command : '',
        environment: [...strList(doc.environment), ...strList(spec.environment)],
        dependsOn: isRecord(spec.depends_on) ? Object.keys(spec.depends_on) : [],
      },
      info,
    );
    if (!matches) this.log.warn(`${path} no longer describes the running ${name} — it cannot source a revive`);
    return matches ? spec : null;
  }

  /** Checks the config actually submitted, not the inputs it was built from: any cause that leaves the
   *  pin uncovered ends here. Command and environment only — the two fields the pin writes verbatim. */
  private async refusePinGap(cfgPath: string, scope: ApplyScope): Promise<void> {
    const doc = loadYaml(readFileSync(cfgPath, 'utf8'));
    if (!isRecord(doc) || !isRecord(doc.processes)) return;
    const processes = doc.processes;
    const sameEnv = (a: unknown, b: string[]): boolean =>
      Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
    const gaps: string[] = [];
    for (const proc of await this.pc.listAll()) {
      const spec = processes[proc.name];
      // a supervised process the render dropped is refuseSwapBeyondScope's case, not this one
      if (!isRecord(spec)) continue;
      const namespace = typeof spec.namespace === 'string' ? spec.namespace : '';
      if (inApplyScope(scope, proc.name, namespace)) continue;
      const info = await this.pc.processInfo(proc.name);
      if (spec.command !== info.command || !sameEnv(spec.environment, info.environment ?? [])) gaps.push(proc.name);
    }
    if (gaps.length === 0) return;
    throw new Error(
      `overlay apply refused: ${gaps.join(', ')} still carry the render's spec outside the ${describeApplyScope(scope)} scope — the pin did not take`,
    );
  }

  /** Deliberately redundant with the pinning above: a regression there must be loud, not destructive.
   *  A supervised process missing from the submitted config offends exactly as a swapped one does. */
  private async refuseSwapBeyondScope(
    cfgPath: string,
    scope: ApplyScope,
    namespaces: Map<string, string>,
  ): Promise<void> {
    const submitted = submittedProcessNames(cfgPath);
    const dropped = (await this.pc.listAll()).map((p) => p.name).filter((name) => !submitted.has(name));
    const suspects = new Set([...(await swapDiffSet(this.pc, cfgPath)), ...dropped]);
    const offenders = [...suspects].filter((name) => !inApplyScope(scope, name, namespaces.get(name) ?? ''));
    if (offenders.length === 0) return;
    throw new Error(
      `overlay apply refused: it would recreate or delete ${offenders.join(', ')} outside the ${describeApplyScope(scope)} scope — run Redeploy instead`,
    );
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
