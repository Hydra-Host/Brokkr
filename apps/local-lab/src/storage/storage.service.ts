import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, arch as osArch } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { getErrorMessage } from '@repo/utils';
import { DiscoveryInventorySchema, type ArchInv } from '../common/discovery-inventory';
import { sleep } from '../common/sleep';
import type {
  DiscoveryProvenance,
  DiscoverySync,
  StorageCategory,
  StorageItem,
  StorageState,
  StorageVerifyResult,
  StorageVerifyStatus,
  WipeableCategoryId,
} from '../contract';
import { DiscoverySyncSchema } from '../contract';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import { LayerCacheService } from '../layers/layer-cache.service';
import { HOSTS, PORTS } from '../ports';
import { RunnerService, type RunState } from '../runner/runner.service';
import { syncVersionScanPattern } from '../runtime/runtime-keys';
import { ProcessComposeClient } from '../services/process-compose.client';
import { ProcessEnvService } from '../services/process-env.service';

export const REQUIRED_DISCOVERY_FILES = ['vmlinuz', 'initrd.img', 'brokkr-discovery.iso'] as const;

const PRIMARY_SPOKE = 'spoke';
const LOCAL_STATE = process.env.LOCAL_STATE || join(homedir(), '.local/share/local');
const BRIDGE_ENDPOINT = process.env.BRIDGE_ENDPOINT || `http://${HOSTS.loopback}:${PORTS.spoke.base}`;
const BLOB_COUNT_TTL_MS = 30_000;
const RESYNC_TIMEOUT_MS = 180_000;
// a cold CDN edge answers a multi-KB manifest in well under this; the default 3 s read a slow one as unverified
const MANIFEST_TIMEOUT_MS = 20_000;
const NO_SPOKE_ENV = 'spoke env unreadable — path unknown';

// the bridge's own url rule (sync/brokkr-live-https-sync.service.ts), restated because the lab imports neither app
const FLAVOR_URL_SUFFIX: Record<string, string> = { light: '-light' };

export function flavorBaseUrl(root: string, flavor: string): string {
  return `${root.replace(/\/+$/, '')}${FLAVOR_URL_SUFFIX[flavor] ?? ''}`;
}

// the bridge status route is snake_case on the wire; the contract keeps the lab's camelCase
const wireDiscoverySyncSchema = DiscoverySyncSchema.omit({ baseUrl: true }).extend({ base_url: z.string() });
const statusSchema = z.object({ discovery_sync: wireDiscoverySyncSchema.nullish() });
const cacheMetaSchema = z.record(z.string(), z.object({ sha256sum: z.string().optional() }));
const manifestSchema = z.object({ files: z.array(z.object({ name: z.string(), sha256sum: z.string().optional() })) });

type SpokeEnv = ReadonlyMap<string, string>;

const treeKey = (flavor: string, arch: string): string => `${flavor}/${arch}`;

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

// Allocated size (st_blocks*512) so sparse overlays don't overstate; symlinks skipped to avoid recursion loops and double-counting.
export function listFiles(dir: string): StorageItem[] {
  const out: StorageItem[] = [];
  const walk = (d: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let s: ReturnType<typeof lstatSync>;
      try {
        s = lstatSync(full);
      } catch {
        continue;
      }
      if (s.isSymbolicLink()) continue;
      const relName = rel ? `${rel}/${name}` : name;
      if (s.isDirectory()) {
        walk(full, relName);
        continue;
      }
      out.push({ name: relName, present: true, sizeBytes: s.blocks * 512, mtimeMs: Math.trunc(s.mtimeMs), path: full });
    }
  };
  walk(dir, '');
  return out;
}

export function originHostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

export function readCacheMetadata(dir: string): Record<string, { sha256sum?: string }> {
  try {
    const parsed = cacheMetaSchema.safeParse(JSON.parse(readFileSync(join(dir, '.cache_metadata.json'), 'utf-8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function assembleDiscoveryItems(
  inv: ArchInv[],
  baseDir: string | null,
  shaByTree: Record<string, Record<string, string>>,
  servedByTree: Record<string, Record<string, boolean>>,
): StorageItem[] {
  const items: StorageItem[] = [];
  for (const a of inv) {
    const key = treeKey(a.flavor, a.arch);
    for (const f of a.files) {
      const sha = shaByTree[key]?.[f.name];
      items.push({
        name: f.name,
        present: f.present,
        sizeBytes: f.sizeBytes,
        mtimeMs: f.mtimeMs,
        path: baseDir === null ? '' : join(baseDir, a.flavor, a.arch, f.name),
        flavor: a.flavor,
        arch: a.arch,
        ...(sha ? { sha256: sha } : {}),
        served: servedByTree[key]?.[f.name] ?? false,
      });
    }
  }
  return items;
}

export function blobsToItems(
  blobs: { sha: string; path: string; sizeBytes: number; mtimeMs: number }[],
): StorageItem[] {
  return blobs.map((b) => ({
    name: `sha256:${b.sha}`,
    present: true,
    sizeBytes: b.sizeBytes,
    mtimeMs: b.mtimeMs,
    path: b.path,
    sha256: b.sha,
  }));
}

// any flavor counts: the chain picks the flavor per device, and the sim VMs only need their own arch served
export function computeDiscoveryOk(items: StorageItem[], hostArch: string, required: readonly string[]): boolean {
  const hostItems = items.filter((i) => i.arch === hostArch);
  if (hostItems.length === 0) return false;
  return required.every((name) => hostItems.some((i) => i.name === name && i.present && i.served === true));
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 3000): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function hostArchSegment(): string {
  return osArch() === 'arm64' ? 'arm64' : 'amd64';
}

async function fetchInventory(): Promise<ArchInv[] | null> {
  const res = await fetchWithTimeout(`${BRIDGE_ENDPOINT}/api/discovery/inventory`, { method: 'GET' });
  if (!res || !res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  const parsed = DiscoveryInventorySchema.safeParse(body);
  return parsed.success ? parsed.data.architectures : null;
}

export function discoverySyncFromStatus(body: unknown): DiscoverySync | null {
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success || parsed.data.discovery_sync == null) return null;
  const { base_url, ...rest } = parsed.data.discovery_sync;
  return { ...rest, baseUrl: base_url };
}

async function fetchDiscoverySync(): Promise<DiscoverySync | null> {
  const res = await fetchWithTimeout(`${BRIDGE_ENDPOINT}/api/status`, { method: 'GET' });
  if (!res || !res.ok) return null;
  return discoverySyncFromStatus(await res.json().catch(() => null));
}

// spoke:init links <root>/initrd-builds at the shared build dir, and rm on the link would only unlink it
function resolveDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

type ManifestFetch =
  | { shaByName: Record<string, string>; failure: null }
  | {
      shaByName: null;
      failure: { status: Extract<StorageVerifyStatus, 'manifest-unreachable' | 'manifest-invalid'>; error: string };
    };

const unreachable = (error: string): ManifestFetch => ({
  shaByName: null,
  failure: { status: 'manifest-unreachable', error },
});
const invalid = (error: string): ManifestFetch => ({ shaByName: null, failure: { status: 'manifest-invalid', error } });
const timedOut = (): ManifestFetch => unreachable(`timed out after ${MANIFEST_TIMEOUT_MS / 1000}s`);

async function fetchManifest(url: string): Promise<ManifestFetch> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), MANIFEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    } catch (error) {
      return ctrl.signal.aborted ? timedOut() : unreachable(getErrorMessage(error));
    }
    if (!res.ok) return unreachable(`HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      return ctrl.signal.aborted ? timedOut() : invalid(`not json: ${getErrorMessage(error)}`);
    }
    const parsed = manifestSchema.safeParse(body);
    if (!parsed.success) return invalid('manifest carries no files list');
    const shaByName: Record<string, string> = {};
    for (const f of parsed.data.files) {
      if (f.sha256sum) shaByName[f.name] = f.sha256sum;
    }
    return { shaByName, failure: null };
  } finally {
    clearTimeout(t);
  }
}

function verifyStatus(
  localSha: string | undefined,
  name: string,
  manifest: ManifestFetch,
): { status: StorageVerifyStatus; manifestError: string | null } {
  if (manifest.failure !== null) return { status: manifest.failure.status, manifestError: manifest.failure.error };
  if (!localSha) return { status: 'no-local-sha', manifestError: null };
  const upstream = manifest.shaByName[name];
  if (!upstream) return { status: 'manifest-invalid', manifestError: `manifest lists no sha256 for ${name}` };
  return { status: upstream === localSha ? 'match' : 'stale', manifestError: null };
}

const storageRoot = (env: SpokeEnv): string | null => env.get('PERSISTENT_STORAGE_PATH') || null;
const discoveryDirOf = (root: string | null): string | null => (root === null ? null : join(root, 'brokkr-live'));

@Injectable()
export class StorageService {
  constructor(
    @Inject(RunnerService) private readonly runner: Pick<RunnerService, 'create' | 'emit' | 'spawn' | 'finalize'>,
    @Inject(ProcessComposeClient) private readonly pc: Pick<ProcessComposeClient, 'restartAndWait' | 'list'>,
    @Inject(LayerCacheService) private readonly layerCache: Pick<LayerCacheService, 'cachedBlobs'>,
    @Inject(ProcessEnvService) private readonly processEnv: Pick<ProcessEnvService, 'getProcessEnv'>,
    @Inject(RedisConnectionsService) private readonly connections: Pick<RedisConnectionsService, 'client'>,
  ) {}

  private lastSyncedMsCache = 0;
  private blobCache: { at: number; items: StorageItem[] } | null = null;

  async state(): Promise<StorageState> {
    const env = await this.spokeEnv();
    const root = storageRoot(env);
    const discoveryDir = discoveryDirOf(root);
    const [inv, lastSync] = await Promise.all([this.discoveryInventory(discoveryDir), fetchDiscoverySync()]);
    const reachable = inv !== null;
    const items = inv ?? [];

    const categories: StorageCategory[] = [
      this.discoveryCategory(discoveryDir, items, reachable),
      this.scanCategory(
        'built-artifacts',
        'Built initrds',
        root === null ? null : join(root, 'initrd-builds'),
        true,
        'built by Build → agent; wiping needs a rebuild',
      ),
      this.scanCategory('boot-artifacts', 'Sim boot artifacts', join(LOCAL_STATE, 'boot'), true),
      this.scanCategory(
        'overlays',
        'Disk overlays',
        join(LOCAL_STATE, 'disks', 'overlays'),
        false,
        'wipe via Fleet nuke',
      ),
      await this.nginxCategory(),
    ];

    const prov = this.provenance(env, items, reachable);
    const totalBytes = categories.reduce((n, c) => n + c.sizeBytes, 0);
    const discoveryOk = reachable && computeDiscoveryOk(items, prov.hostArch, REQUIRED_DISCOVERY_FILES);
    return { totalBytes, provenance: prov, discoveryReachable: reachable, discoveryOk, lastSync, categories };
  }

  async verify(): Promise<StorageVerifyResult> {
    const env = await this.spokeEnv();
    const discoveryDir = discoveryDirOf(storageRoot(env));
    const version = env.get('BROKKR_LIVE_VERSION') ?? '';
    const baseUrl = env.get('DISCOVERY_BASE_URL') ?? '';
    const inv = await fetchInventory();
    if (inv === null) {
      throw new ServiceUnavailableException('spoke unreachable — cannot verify discovery images');
    }
    const results: StorageVerifyResult['results'] = [];
    for (const a of inv) {
      const local = discoveryDir === null ? {} : readCacheMetadata(join(discoveryDir, a.flavor, a.arch));
      const manifest = await fetchManifest(`${flavorBaseUrl(baseUrl, a.flavor)}/${version}/${a.arch}/manifest.json`);
      for (const f of a.files) {
        results.push({
          flavor: a.flavor,
          arch: a.arch,
          name: f.name,
          ...verifyStatus(local[f.name]?.sha256sum, f.name, manifest),
        });
      }
    }
    return { results };
  }

  wipe(category: WipeableCategoryId): string {
    const run = this.runner.create({ section: 'storage', opId: 'wipe-storage', label: `wipe ${category}` });
    void this.runWipe(run, category);
    return run.runId;
  }

  private async runWipe(run: RunState, category: WipeableCategoryId): Promise<void> {
    const path = await this.wipePath(category);
    if (path === null) {
      this.runner.emit(
        run,
        `\r\n[storage] the spoke env has no PERSISTENT_STORAGE_PATH — ${category} path unknown, nothing wiped\r\n`,
      );
      this.runner.finalize(run, 1);
      return;
    }
    this.runner.emit(run, `\r\n[storage] wiping ${path}\r\n`);
    const code = await this.runner.spawn(run, 'rm', ['-rf', path]);
    this.runner.finalize(run, code);
  }

  private async wipePath(category: WipeableCategoryId): Promise<string | null> {
    if (category === 'boot-artifacts') return join(LOCAL_STATE, 'boot');
    const root = storageRoot(await this.spokeEnv());
    if (root === null) return null;
    return category === 'discovery-images' ? join(root, 'brokkr-live') : resolveDir(join(root, 'initrd-builds'));
  }

  resync(): string {
    const run = this.runner.create({
      section: 'storage',
      opId: 'resync-storage',
      label: 'resync discovery images',
    });
    this.runner.emit(run, `\r\n[storage] restarting spoke to re-run bridge_sync\r\n`);
    void this.runResync(run);
    return run.runId;
  }

  private async runResync(run: RunState): Promise<void> {
    try {
      const env = await this.spokeEnv();
      const discoveryDir = discoveryDirOf(storageRoot(env));
      const cleared = await this.clearSyncVersionCache(env.get('BRIDGE_HOSTNAME') || PRIMARY_SPOKE);
      this.runner.emit(run, `[storage] cleared the sync version cache (${cleared} keys)\r\n`);
      const before = await this.spokePid();
      if (!(await this.pc.restartAndWait(PRIMARY_SPOKE))) {
        const after = await this.spokePid();
        this.runner.emit(
          run,
          before !== null && before === after
            ? `[storage] spoke process did not change (pid ${before}); restart it from the Stack page\r\n`
            : `[storage] spoke failed to restart (stop or start) — aborting the resync\r\n`,
        );
        this.runner.finalize(run, 1);
        return;
      }
      this.runner.emit(run, `[storage] spoke restarted — waiting for discovery images to be served…\r\n`);
      const ok = await this.waitForDiscoveryServed(run, RESYNC_TIMEOUT_MS, discoveryDir);
      this.runner.finalize(run, ok ? 0 : 1);
    } catch (e) {
      this.runner.emit(run, `[error] ${getErrorMessage(e)}\n`);
      this.runner.finalize(run, 1);
    }
  }

  // the bridge only re-syncs when its version key is gone (sync/discovery-sync.ts), so this is the
  // force path it already honors; the scan clears the legacy single key and the per-flavor keys
  private async clearSyncVersionCache(instance: string): Promise<number> {
    const redis = this.connections.client('bridge');
    const pattern = syncVersionScanPattern(instance);
    let cursor = '0';
    let cleared = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      if (keys.length > 0) cleared += await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    return cleared;
  }

  private async spokePid(): Promise<number | null> {
    const pid = (await this.pc.list()).find((p) => p.name === PRIMARY_SPOKE)?.pid;
    return typeof pid === 'number' && pid > 0 ? pid : null;
  }

  private async waitForDiscoveryServed(
    run: RunState,
    timeoutMs: number,
    discoveryDir: string | null,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const hostArch = hostArchSegment();
    while (Date.now() < deadline) {
      const items = await this.discoveryInventory(discoveryDir);
      if (items !== null && computeDiscoveryOk(items, hostArch, REQUIRED_DISCOVERY_FILES)) {
        this.runner.emit(run, `[storage] discovery images served ✓\r\n`);
        return true;
      }
      this.runner.emit(run, `[storage] …not ready yet\r\n`);
      await sleep(3000);
    }
    this.runner.emit(
      run,
      `[storage] timed out after ${Math.round(timeoutMs / 1000)}s waiting for discovery images\r\n`,
    );
    return false;
  }

  private discoveryCategory(dir: string | null, items: StorageItem[], reachable: boolean): StorageCategory {
    const present = items.filter((i) => i.present);
    const detail = !reachable
      ? 'spoke unreachable — status unknown'
      : present.length > 0
        ? `${present.length} files`
        : 'not synced — VMs will 404 at iPXE';
    return {
      id: 'discovery-images',
      label: 'Discovery images (synced)',
      present: present.length > 0,
      sizeBytes: present.reduce((n, i) => n + i.sizeBytes, 0),
      fileCount: present.length,
      mtimeMs: present.reduce((m, i) => Math.max(m, i.mtimeMs), 0),
      wipeable: true,
      detail,
      path: dir ?? '',
      items,
    };
  }

  private scanCategory(
    id: StorageCategory['id'],
    label: string,
    dir: string | null,
    wipeable: boolean,
    detail?: string,
  ): StorageCategory {
    const items = dir === null ? [] : listFiles(dir);
    return {
      id,
      label,
      present: items.length > 0,
      sizeBytes: items.reduce((n, i) => n + i.sizeBytes, 0),
      fileCount: items.length,
      mtimeMs: items.reduce((m, i) => Math.max(m, i.mtimeMs), 0),
      wipeable,
      detail: dir === null ? NO_SPOKE_ENV : (detail ?? `${items.length} files`),
      path: dir ?? '',
      items,
    };
  }

  private async nginxCategory(): Promise<StorageCategory> {
    const items = await this.blobItems();
    return {
      id: 'nginx-cache',
      label: 'OS-layer cache',
      present: items.length > 0,
      sizeBytes: items.reduce((n, i) => n + i.sizeBytes, 0),
      fileCount: items.length,
      mtimeMs: items.reduce((m, i) => Math.max(m, i.mtimeMs), 0),
      wipeable: false,
      detail: `${items.length} blobs — manage in Layers`,
      path: '',
      items,
    };
  }

  private async blobItems(): Promise<StorageItem[]> {
    const now = Date.now();
    if (this.blobCache && now - this.blobCache.at < BLOB_COUNT_TTL_MS) return this.blobCache.items;
    const items = blobsToItems(await this.layerCache.cachedBlobs());
    this.blobCache = { at: now, items };
    return items;
  }

  // one rendered-config read per poll; the spoke's own env is the only source of what it syncs and where
  private async spokeEnv(): Promise<SpokeEnv> {
    const env = await this.processEnv.getProcessEnv(PRIMARY_SPOKE, false).catch(() => null);
    return new Map((env?.vars ?? []).map((v) => [v.key, v.value]));
  }

  private provenance(env: SpokeEnv, discoveryItems: StorageItem[], reachable: boolean): DiscoveryProvenance {
    if (reachable) {
      const ls = discoveryItems.reduce((m, i) => Math.max(m, i.mtimeMs), 0);
      if (ls > 0) this.lastSyncedMsCache = ls;
    }
    const baseUrl = env.get('DISCOVERY_BASE_URL') ?? '';
    const configured = splitList(env.get('DISCOVERY_FLAVORS'));
    const names =
      configured.length > 0
        ? configured
        : [...new Set(discoveryItems.flatMap((i) => (i.flavor === undefined ? [] : [i.flavor])))];
    const flavors = names.map((name) => {
      const present = discoveryItems.filter((i) => i.flavor === name && i.present);
      return {
        name,
        present: present.length > 0,
        fileCount: present.length,
        sizeBytes: present.reduce((n, i) => n + i.sizeBytes, 0),
      };
    });
    return {
      version: env.get('BROKKR_LIVE_VERSION') ?? '',
      baseUrl,
      originHost: originHostFromBaseUrl(baseUrl),
      architectures: splitList(env.get('DISCOVERY_ARCHITECTURES')),
      flavors,
      hostArch: hostArchSegment(),
      lastSyncedMs: this.lastSyncedMsCache,
    };
  }

  private async discoveryInventory(baseDir: string | null): Promise<StorageItem[] | null> {
    const inv = await fetchInventory();
    if (inv === null) return null;
    const shaByTree: Record<string, Record<string, string>> = {};
    const servedByTree: Record<string, Record<string, boolean>> = {};
    for (const a of inv) {
      const key = treeKey(a.flavor, a.arch);
      const meta = baseDir === null ? {} : readCacheMetadata(join(baseDir, a.flavor, a.arch));
      shaByTree[key] = Object.fromEntries(
        Object.entries(meta).flatMap(([n, m]) => (typeof m.sha256sum === 'string' ? [[n, m.sha256sum]] : [])),
      );
      servedByTree[key] = Object.fromEntries(a.files.map((f) => [f.name, f.present]));
    }
    return assembleDiscoveryItems(inv, baseDir, shaByTree, servedByTree);
  }
}
