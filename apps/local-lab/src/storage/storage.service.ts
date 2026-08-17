import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, arch as osArch } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { getErrorMessage } from '../common/errors';
import { sleep } from '../common/sleep';
import type {
  DiscoveryProvenance,
  StorageCategory,
  StorageItem,
  StorageState,
  StorageVerifyResult,
  WipeableCategoryId,
} from '../contract';
import { LayerCacheService } from '../layers/layer-cache.service';
import { HOSTS, PORTS } from '../ports';
import { RunnerService, type RunState } from '../runner/runner.service';
import { ProcessComposeClient } from '../services/process-compose.client';
import { ProcessEnvService } from '../services/process-env.service';

export const REQUIRED_DISCOVERY_FILES = ['vmlinuz', 'initrd.img', 'brokkr-discovery.iso'] as const;

const PRIMARY_SPOKE = 'spoke';
const PERSISTENT_STORAGE = process.env.PERSISTENT_STORAGE_PATH || '/tmp/brokkr-dev';
const LOCAL_STATE = process.env.LOCAL_STATE || join(homedir(), '.local/share/local');
const BRIDGE_ENDPOINT = process.env.BRIDGE_ENDPOINT || `http://${HOSTS.loopback}:${PORTS.spoke.base}`;
const BLOB_COUNT_TTL_MS = 30_000;
const RESYNC_TIMEOUT_MS = 180_000;

export interface ArchInv {
  arch: string;
  files: { name: string; present: boolean; sizeBytes: number; mtimeMs: number }[];
}

const inventorySchema = z.object({
  architectures: z.array(
    z.object({
      arch: z.string().regex(/^[A-Za-z0-9._-]+$/),
      files: z.array(z.object({ name: z.string(), present: z.boolean(), sizeBytes: z.number(), mtimeMs: z.number() })),
    }),
  ),
});
const cacheMetaSchema = z.record(z.string(), z.object({ sha256sum: z.string().optional() }));
const manifestSchema = z.object({ files: z.array(z.object({ name: z.string(), sha256sum: z.string().optional() })) });

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
  baseDir: string,
  shaByArch: Record<string, Record<string, string>>,
  servedByArch: Record<string, Record<string, boolean>>,
): StorageItem[] {
  const items: StorageItem[] = [];
  for (const a of inv) {
    for (const f of a.files) {
      const sha = shaByArch[a.arch]?.[f.name];
      items.push({
        name: f.name,
        present: f.present,
        sizeBytes: f.sizeBytes,
        mtimeMs: f.mtimeMs,
        path: join(baseDir, a.arch, f.name),
        arch: a.arch,
        ...(sha ? { sha256: sha } : {}),
        served: servedByArch[a.arch]?.[f.name] ?? false,
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

export function computeDiscoveryOk(items: StorageItem[], hostArch: string, required: readonly string[]): boolean {
  const hostItems = items.filter((i) => i.arch === hostArch);
  if (hostItems.length === 0) return false;
  return required.every((name) => {
    const it = hostItems.find((i) => i.name === name);
    return it !== undefined && it.present && it.served === true;
  });
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
  const parsed = inventorySchema.safeParse(body);
  return parsed.success ? parsed.data.architectures : null;
}

function wipePathFor(category: WipeableCategoryId): string {
  switch (category) {
    case 'discovery-images':
      return join(PERSISTENT_STORAGE, PRIMARY_SPOKE, 'brokkr-live');
    case 'built-artifacts':
      return join(PERSISTENT_STORAGE, 'initrd-builds');
    case 'boot-artifacts':
      return join(LOCAL_STATE, 'boot');
  }
}

function manifestShaMap(manifest: unknown): Record<string, string> {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) return {};
  const out: Record<string, string> = {};
  for (const f of parsed.data.files) {
    if (f.sha256sum) out[f.name] = f.sha256sum;
  }
  return out;
}

@Injectable()
export class StorageService {
  constructor(
    private readonly runner: RunnerService,
    private readonly pc: ProcessComposeClient,
    private readonly layerCache: LayerCacheService,
    private readonly processEnv: ProcessEnvService,
  ) {}

  private provenanceCache: Omit<DiscoveryProvenance, 'lastSyncedMs'> | null = null;
  private lastSyncedMsCache = 0;
  private blobCache: { at: number; items: StorageItem[] } | null = null;

  async state(): Promise<StorageState> {
    const discoveryDir = join(PERSISTENT_STORAGE, PRIMARY_SPOKE, 'brokkr-live');
    const inv = await this.discoveryInventory(discoveryDir);
    const reachable = inv !== null;
    const items = inv ?? [];

    const categories: StorageCategory[] = [
      this.discoveryCategory(discoveryDir, items, reachable),
      this.scanCategory('built-artifacts', 'Built initrds', join(PERSISTENT_STORAGE, 'initrd-builds'), true),
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

    const prov = await this.provenance(items, reachable);
    const totalBytes = categories.reduce((n, c) => n + c.sizeBytes, 0);
    const discoveryOk = reachable && computeDiscoveryOk(items, prov.hostArch, REQUIRED_DISCOVERY_FILES);
    return { totalBytes, provenance: prov, discoveryReachable: reachable, discoveryOk, categories };
  }

  async verify(): Promise<StorageVerifyResult> {
    const baseDir = join(PERSISTENT_STORAGE, PRIMARY_SPOKE, 'brokkr-live');
    const version = await this.spokeEnvValue('BROKKR_LIVE_VERSION');
    const baseUrl = await this.spokeEnvValue('DISCOVERY_BASE_URL');
    const inv = await fetchInventory();
    if (inv === null) {
      throw new ServiceUnavailableException('spoke unreachable — cannot verify discovery images');
    }
    const results: StorageVerifyResult['results'] = [];
    for (const a of inv) {
      const local = readCacheMetadata(join(baseDir, a.arch));
      const manifestRes = await fetchWithTimeout(`${baseUrl}/${version}/${a.arch}/manifest.json`, { method: 'GET' });
      const upstream = manifestShaMap(
        manifestRes && manifestRes.ok ? await manifestRes.json().catch(() => null) : null,
      );
      for (const f of a.files) {
        const localSha = local[f.name]?.sha256sum;
        const upSha = upstream[f.name];
        const status = !localSha || !upSha ? 'unverified' : localSha === upSha ? 'match' : 'stale';
        results.push({ arch: a.arch, name: f.name, status });
      }
    }
    return { results };
  }

  wipe(category: WipeableCategoryId): string {
    const path = wipePathFor(category);
    const run = this.runner.create({ section: 'storage', opId: 'wipe-storage', label: `wipe ${category}` });
    this.runner.emit(run, `\r\n[storage] wiping ${path}\r\n`);
    void this.runner.spawn(run, 'rm', ['-rf', path]).then((c) => this.runner.finalize(run, c));
    return run.runId;
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
      if (!(await this.pc.restartAndWait(PRIMARY_SPOKE))) {
        this.runner.emit(run, `[storage] spoke failed to restart (stop or start) — aborting the resync\r\n`);
        this.runner.finalize(run, 1);
        return;
      }
      this.runner.emit(run, `[storage] spoke restarted — waiting for discovery images to be served…\r\n`);
      const ok = await this.waitForDiscoveryServed(run, RESYNC_TIMEOUT_MS);
      this.runner.finalize(run, ok ? 0 : 1);
    } catch (e) {
      this.runner.emit(run, `[error] ${getErrorMessage(e)}\n`);
      this.runner.finalize(run, 1);
    }
  }

  private async waitForDiscoveryServed(run: RunState, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const hostArch = hostArchSegment();
    const dir = join(PERSISTENT_STORAGE, PRIMARY_SPOKE, 'brokkr-live');
    while (Date.now() < deadline) {
      const items = await this.discoveryInventory(dir);
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

  private discoveryCategory(dir: string, items: StorageItem[], reachable: boolean): StorageCategory {
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
      path: dir,
      items,
    };
  }

  private scanCategory(
    id: StorageCategory['id'],
    label: string,
    dir: string,
    wipeable: boolean,
    detail?: string,
  ): StorageCategory {
    const items = listFiles(dir);
    return {
      id,
      label,
      present: items.length > 0,
      sizeBytes: items.reduce((n, i) => n + i.sizeBytes, 0),
      fileCount: items.length,
      mtimeMs: items.reduce((m, i) => Math.max(m, i.mtimeMs), 0),
      wipeable,
      detail: detail ?? `${items.length} files`,
      path: dir,
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

  private async spokeEnvValue(key: string): Promise<string> {
    const env = await this.processEnv.getProcessEnv(PRIMARY_SPOKE, false).catch(() => null);
    return env?.vars.find((v) => v.key === key)?.value ?? '';
  }

  private async provenance(discoveryItems: StorageItem[], reachable: boolean): Promise<DiscoveryProvenance> {
    if (reachable) {
      const ls = discoveryItems.reduce((m, i) => Math.max(m, i.mtimeMs), 0);
      if (ls > 0) this.lastSyncedMsCache = ls;
    }
    if (this.provenanceCache === null) {
      const version = await this.spokeEnvValue('BROKKR_LIVE_VERSION');
      const baseUrl = await this.spokeEnvValue('DISCOVERY_BASE_URL');
      const architectures = (await this.spokeEnvValue('DISCOVERY_ARCHITECTURES'))
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      if (!version && !baseUrl && architectures.length === 0) {
        return {
          version: '',
          originHost: '',
          architectures: [],
          hostArch: hostArchSegment(),
          lastSyncedMs: this.lastSyncedMsCache,
        };
      }
      this.provenanceCache = {
        version,
        originHost: originHostFromBaseUrl(baseUrl),
        architectures,
        hostArch: hostArchSegment(),
      };
    }
    return { ...this.provenanceCache, lastSyncedMs: this.lastSyncedMsCache };
  }

  private async discoveryInventory(baseDir: string): Promise<StorageItem[] | null> {
    const inv = await fetchInventory();
    if (inv === null) return null;
    const shaByArch: Record<string, Record<string, string>> = {};
    const servedByArch: Record<string, Record<string, boolean>> = {};
    for (const a of inv) {
      const meta = readCacheMetadata(join(baseDir, a.arch));
      shaByArch[a.arch] = Object.fromEntries(
        Object.entries(meta).flatMap(([n, m]) => (typeof m.sha256sum === 'string' ? [[n, m.sha256sum]] : [])),
      );
      servedByArch[a.arch] = Object.fromEntries(a.files.map((f) => [f.name, f.present]));
    }
    return assembleDiscoveryItems(inv, baseDir, shaByArch, servedByArch);
  }
}
