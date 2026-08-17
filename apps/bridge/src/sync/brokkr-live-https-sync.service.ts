import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequestArgs, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { getErrorMessage } from '../common/error-utils';
import { getDiscoveryFileConfig } from '../download/discovery.config.js';

import { allowsUnverifiedArtifacts, getStorageConfig, getSyncConfig, type SyncConfig } from './sync.config.js';
import { logDebug, logError, logInfo, logWarning } from './sync.logger.js';

const APP_CLASS_NAME = 'service-sync';
const CONNECT_TIMEOUT_MS = 30_000;

export class HTTPSSyncError extends Error {}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ManifestFileEntry = {
  name?: unknown;
  size?: unknown;
  sha256sum?: unknown;
  description?: unknown;
  [k: string]: unknown;
};

export type DiscoveryManifest = {
  version?: unknown;
  files?: unknown;
  [k: string]: unknown;
};

export type CacheMetadataEntry = {
  sha256sum?: unknown;
  filename?: unknown;
  size?: unknown;
  last_updated?: unknown;
  [k: string]: unknown;
};

export type CacheMetadata = Record<string, CacheMetadataEntry>;

export function buildDiscoveryManifestUrl(baseUrl: string, version: string, arch: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${version}/${arch}/manifest.json`;
}

export function resolveFileVersion(configuredVersion: string, manifest: DiscoveryManifest): string {
  if (!configuredVersion.startsWith('latest-')) return configuredVersion;
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new HTTPSSyncError(`Manifest for '${configuredVersion}' has an invalid 'version' pointer`);
  }
  return manifest.version;
}

export function buildArchCacheDir(baseDir: string, arch: string): string {
  return join(baseDir, arch);
}

export type DownloadVerification = 'ok' | 'size_mismatch' | 'sha256_mismatch';

export function classifyDownloadVerification(
  downloadedSize: number,
  computedSha256: string,
  expectedSize: unknown,
  expectedSha256: unknown,
): DownloadVerification {
  const sizeForCheck = typeof expectedSize === 'boolean' ? Number(expectedSize) : expectedSize;
  if (typeof sizeForCheck !== 'number') {
    throw new TypeError(`expected_size must be a number, got ${typeof expectedSize}`);
  }
  if (sizeForCheck > 0 && downloadedSize !== sizeForCheck) return 'size_mismatch';
  if (expectedSha256 && computedSha256 !== expectedSha256) return 'sha256_mismatch';
  return 'ok';
}

export type CacheAction = 'skip' | 'download';

export function decideCacheAction(
  fileInfo: Readonly<{ sha256sum?: unknown }> | null,
  cachedMetadata: Readonly<{ sha256sum?: unknown }> | null,
  fileExists: boolean,
): CacheAction {
  if (!fileInfo) return 'download';
  const manifestSha256 = typeof fileInfo.sha256sum === 'string' ? fileInfo.sha256sum : '';
  if (!manifestSha256) return 'download';
  if (!cachedMetadata || cachedMetadata.sha256sum !== manifestSha256) return 'download';
  if (!fileExists) return 'download';
  return 'skip';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fresh Agent per request so verifySsl=false never leaks into the process-wide default agent. */
export function buildHttpsRequestAgent(verifySsl: boolean): HttpsAgent {
  return new HttpsAgent({ rejectUnauthorized: verifySsl });
}

export function createNodeHttpsFetch(verifySsl: boolean): FetchLike {
  return (input, init) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input));
    return new Promise<Response>((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const requestFn = isHttps ? httpsRequest : httpRequest;
      const options: ClientRequestArgs = {
        method: init?.method ?? 'GET',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        headers: init?.headers as Record<string, string> | undefined,
      };
      if (isHttps) {
        (options as { agent?: HttpsAgent }).agent = buildHttpsRequestAgent(verifySsl);
      }

      const signal = init?.signal;
      const onAbort = () => req.destroy(new Error('aborted'));
      if (signal) {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const req = requestFn(options, (res: IncomingMessage) => {
        const webStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        const status = res.statusCode ?? 0;
        const response = new Response(webStream, {
          status,
          statusText: res.statusMessage ?? '',
          headers: flattenHeaders(res.headers),
        });
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(response);
      });

      req.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      req.end();
    });
  };
}

function flattenHeaders(headers: IncomingMessage['headers']): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(name, v);
    } else {
      out.set(name, String(value));
    }
  }
  return out;
}

function isFetchTransportError(exc: TypeError): boolean {
  return (exc as { cause?: unknown }).cause !== undefined;
}

function sizedLength(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length;
  return 0;
}

const SAFE_MANIFEST_FILENAME = /^[A-Za-z0-9._-]+$/;

export function isSafeManifestFilename(name: string): boolean {
  return name !== '.' && name !== '..' && SAFE_MANIFEST_FILENAME.test(name);
}

export function hasVerifiableSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hashInto(hasher: ReturnType<typeof createHash>, path: string): Promise<void> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hasher.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
}

export class BrokkrLiveHTTPSSyncService {
  private readonly syncConfig: SyncConfig;
  private readonly fetchFn: FetchLike;
  private cacheMetadata: CacheMetadata = {};
  private cacheDir: string;
  private metadataFile: string;

  constructor(
    private readonly jobId: string = '',
    fetchFn?: FetchLike,
  ) {
    this.syncConfig = getSyncConfig();
    this.fetchFn = fetchFn ?? createNodeHttpsFetch(this.syncConfig.httpsVerifySsl);
    this.cacheDir = getStorageConfig().brokkrLiveHttpsDir;
    this.metadataFile = join(this.cacheDir, '.cache_metadata.json');
  }

  async syncDiscoveryImages(): Promise<number> {
    logInfo(`Starting Brokkr Live discovery image sync (version: ${this.syncConfig.brokkrLiveVersion})`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });

    try {
      const architectures = this.getArchitectures();

      logInfo(`Syncing discovery images for architectures: ${architectures.join(', ')}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });

      let syncedCount = 0;
      for (const arch of architectures) {
        if (await this.syncArchitecture(arch)) {
          syncedCount += 1;
        }
      }

      if (syncedCount > 0) {
        logInfo(`Brokkr Live discovery image sync completed (${syncedCount}/${architectures.length} architectures)`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
      } else {
        logWarning('Brokkr Live discovery image sync found no files for any architecture', {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
      }

      return syncedCount;
    } catch (exc) {
      if (exc instanceof HTTPSSyncError) throw exc;
      logError(`Brokkr Live discovery image sync failed: ${getErrorMessage(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      throw new HTTPSSyncError(`Discovery sync failed: ${getErrorMessage(exc)}`);
    }
  }

  private async syncArchitecture(arch: string): Promise<boolean> {
    logInfo(`Syncing discovery images for ${arch}`, { appClassName: APP_CLASS_NAME, jobId: this.jobId });

    const originalCacheDir = this.cacheDir;
    const originalMetadataFile = this.metadataFile;

    try {
      const archCacheDir = this.getArchCacheDir(arch);
      await mkdir(archCacheDir, { recursive: true });

      this.cacheDir = archCacheDir;
      this.metadataFile = join(archCacheDir, '.cache_metadata.json');

      await this.loadCacheMetadata();

      const manifest = await this.fetchArchitectureManifest(arch);
      if (!manifest) {
        logWarning(`No manifest found for ${arch}, skipping`, { appClassName: APP_CLASS_NAME, jobId: this.jobId });
        return false;
      }

      const rawFiles = manifest.files;
      if (rawFiles === undefined || rawFiles === null) {
        logWarning(`Manifest for ${arch} contains no files, skipping`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
        return false;
      }
      if (!Array.isArray(rawFiles)) {
        if (
          (typeof rawFiles === 'string' && rawFiles.length === 0) ||
          (typeof rawFiles === 'object' && Object.keys(rawFiles as object).length === 0)
        ) {
          logWarning(`Manifest for ${arch} contains no files, skipping`, {
            appClassName: APP_CLASS_NAME,
            jobId: this.jobId,
          });
          return false;
        }
        throw new TypeError(`Manifest for ${arch} has non-array 'files' (got ${typeof rawFiles})`);
      }
      const files = rawFiles as ManifestFileEntry[];
      if (files.length === 0) {
        logWarning(`Manifest for ${arch} contains no files, skipping`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
        return false;
      }

      logInfo(`Found ${files.length} files in ${arch} discovery manifest`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });

      const discoveryBase = this.getDiscoveryBaseUrl();
      const fileVersion = resolveFileVersion(this.syncConfig.brokkrLiveVersion, manifest);
      const baseUrl = `${discoveryBase}/${fileVersion}/${arch}`;

      for (const fileInfo of files) {
        await this.syncFile(baseUrl, fileInfo);
      }

      await this.saveCacheMetadata();

      logInfo(`Cleaning up old cached files for ${arch}`, { appClassName: APP_CLASS_NAME, jobId: this.jobId });
      await this.cleanupOldFiles();

      logInfo(`Discovery image sync for ${arch} completed successfully`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return true;
    } catch (exc) {
      logError(`Discovery image sync for ${arch} failed: ${getErrorMessage(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      throw exc;
    } finally {
      this.cacheDir = originalCacheDir;
      this.metadataFile = originalMetadataFile;
    }
  }

  private async fetchArchitectureManifest(arch: string): Promise<DiscoveryManifest | null> {
    const manifestUrl = this.getDiscoveryManifestUrl(arch);
    logDebug(`Fetching discovery manifest for ${arch}: ${manifestUrl}`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });
    return this.fetchManifest(manifestUrl);
  }

  private async fetchManifest(manifestUrl: string): Promise<DiscoveryManifest | null> {
    const attempts = this.syncConfig.httpsRetryAttempts;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const connectController = new AbortController();
      const connectTimer = setTimeout(() => connectController.abort(), CONNECT_TIMEOUT_MS);
      let response: Response;
      try {
        try {
          response = await this.fetchFn(manifestUrl, { signal: connectController.signal });
        } finally {
          clearTimeout(connectTimer);
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching ${manifestUrl}`);
        }
        const bodyText = await this.readBodyWithReadTimeout(response, manifestUrl);
        const parsed = JSON.parse(bodyText) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new TypeError(
            `Manifest at ${manifestUrl} is not a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`,
          );
        }
        const manifest = parsed as DiscoveryManifest;
        if ('files' in manifest) {
          const files = manifest.files;
          if (files === null || typeof files === 'number' || typeof files === 'boolean') {
            throw new TypeError(
              `Manifest at ${manifestUrl} has non-iterable 'files' (${files === null ? 'null' : typeof files})`,
            );
          }
        }
        const fileCount = sizedLength(manifest.files);
        logDebug(`Fetched manifest: ${fileCount} files`, { appClassName: APP_CLASS_NAME, jobId: this.jobId });
        return manifest;
      } catch (exc) {
        if (exc instanceof TypeError && !isFetchTransportError(exc)) {
          throw exc;
        }
        if (attempt < attempts - 1) {
          logWarning(`Failed to fetch manifest (attempt ${attempt + 1}/${attempts}): ${getErrorMessage(exc)}`, {
            appClassName: APP_CLASS_NAME,
            jobId: this.jobId,
          });
          await sleep(this.syncConfig.httpsRetryDelay * 1000);
        } else {
          logError(`Failed to fetch manifest after ${attempts} attempts: ${getErrorMessage(exc)}`, {
            appClassName: APP_CLASS_NAME,
            jobId: this.jobId,
          });
          return null;
        }
      }
    }
    return null;
  }

  private async syncFile(baseUrl: string, fileInfo: ManifestFileEntry): Promise<void> {
    if (typeof fileInfo.name !== 'string') {
      throw new HTTPSSyncError(`Manifest file entry missing 'name'`);
    }
    const filename = fileInfo.name;
    if (!isSafeManifestFilename(filename)) {
      throw new HTTPSSyncError(`Manifest file entry has unsafe 'name': ${JSON.stringify(filename)}`);
    }
    // Default only when absent — a present-but-mistyped value must flow through raw so classifyDownloadVerification can throw.
    const size: unknown = fileInfo.size === undefined ? 0 : fileInfo.size;
    const manifestSha256: unknown = fileInfo.sha256sum === undefined ? '' : fileInfo.sha256sum;

    const fileUrl = `${baseUrl}/${filename}`;
    const cachePath = join(this.cacheDir, filename);
    // Defense-in-depth beyond the filename regex: resolved path must stay in the cache dir.
    const resolvedCacheDir = resolve(this.cacheDir);
    const resolvedCachePath = resolve(cachePath);
    if (resolvedCachePath !== resolvedCacheDir && !resolvedCachePath.startsWith(`${resolvedCacheDir}${sep}`)) {
      throw new HTTPSSyncError(`Manifest file '${filename}' resolves outside the cache dir`);
    }

    const shaForCacheCheck = typeof manifestSha256 === 'string' ? manifestSha256 : '';
    const cachedMetadata = this.cacheMetadata[filename] ?? null;
    const fileExists = await pathExists(cachePath);
    if (decideCacheAction({ sha256sum: shaForCacheCheck }, cachedMetadata, fileExists) === 'skip') {
      logInfo(`Skipping ${filename} (cached, sha256 matches: ${shaForCacheCheck.slice(0, 16)}...)`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return;
    }

    if (!hasVerifiableSha256(manifestSha256)) {
      if (!allowsUnverifiedArtifacts(this.syncConfig)) {
        throw new HTTPSSyncError(
          `Manifest entry '${filename}' has no sha256sum; refusing to download and trust an unverified artifact`,
        );
      }
      logWarning(
        `Downloading '${filename}' without sha256 verification ` +
          `(environment='${this.syncConfig.environment}', localSimulation=${this.syncConfig.localSimulationEnabled})`,
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
    }

    const sha256Preview = shaForCacheCheck ? shaForCacheCheck.slice(0, 16) : 'unknown';
    logInfo(`Downloading ${filename} (sha256: ${sha256Preview}...)`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });

    const computedSha256 = await this.downloadFile(fileUrl, cachePath, size, manifestSha256);

    this.cacheMetadata[filename] = {
      sha256sum: computedSha256,
      filename,
      size,
      last_updated: Date.now() / 1000,
    };
  }

  private async downloadFile(
    url: string,
    destPath: string,
    expectedSize: unknown,
    expectedSha256: unknown = '',
  ): Promise<string> {
    const attempts = this.syncConfig.httpsRetryAttempts;
    const tempPath = `${destPath}.tmp`;
    const markerPath = `${tempPath}.sha256`;
    const shaMarker = typeof expectedSha256 === 'string' ? expectedSha256 : '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // Resume a partial `.tmp` via Range — without this a multi-GB download on a flaky origin never converges.
        let resumeFrom = 0;
        try {
          resumeFrom = (await stat(tempPath)).size;
        } catch {
          resumeFrom = 0;
        }
        // Only resume a partial proven to belong to THIS artifact — a different-sha partial would append then fail sha verify, wedging the sync; a missing marker is trusted.
        if (resumeFrom > 0) {
          let marker: string | null = null;
          try {
            marker = await readFile(markerPath, 'utf-8');
          } catch {
            marker = null;
          }
          if (marker !== null && marker !== shaMarker) {
            await rm(tempPath, { force: true });
            await rm(markerPath, { force: true });
            resumeFrom = 0;
          }
        }
        // Wipe an oversize partial only when a positive size is known; size<=0 means "unchecked", and wiping would break resume.
        if (typeof expectedSize === 'number' && expectedSize > 0 && resumeFrom > expectedSize) {
          await rm(tempPath, { force: true });
          resumeFrom = 0;
        }

        const stallMs = this.syncConfig.httpsStallTimeout * 1000;

        let hasher = createHash('sha256');
        let downloadedSize = 0;
        if (resumeFrom > 0) {
          await hashInto(hasher, tempPath);
          downloadedSize = resumeFrom;
        }

        const connectController = new AbortController();
        const connectTimer = setTimeout(() => connectController.abort(), CONNECT_TIMEOUT_MS);
        let response: Response;
        try {
          const init: RequestInit = { signal: connectController.signal };
          if (resumeFrom > 0) init.headers = { Range: `bytes=${resumeFrom}-` };
          response = await this.fetchFn(url, init);
        } finally {
          clearTimeout(connectTimer);
        }

        if (resumeFrom > 0 && response.status === 416) {
          await response.body?.cancel().catch(() => {});
          const computed = hasher.digest('hex');
          const verification = classifyDownloadVerification(resumeFrom, computed, expectedSize, expectedSha256);
          if (verification === 'ok') {
            await rename(tempPath, destPath);
            await rm(markerPath, { force: true });
            logInfo(
              `Successfully resumed (already complete): ${filenameOf(destPath)} (sha256: ${computed.slice(0, 16)}...)`,
              {
                appClassName: APP_CLASS_NAME,
                jobId: this.jobId,
              },
            );
            return computed;
          }
          await rm(tempPath, { force: true });
          throw new Error(`Range not satisfiable and cached partial did not verify for ${url}`);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} downloading ${url}`);
        }
        if (response.body === null) {
          throw new Error(`Empty response body downloading ${url}`);
        }

        const resuming = resumeFrom > 0 && response.status === 206;
        if (resumeFrom > 0 && !resuming) {
          await rm(tempPath, { force: true });
          hasher = createHash('sha256');
          downloadedSize = 0;
        }
        const reader = response.body.getReader();
        let handle: Awaited<ReturnType<typeof open>> | null = null;
        try {
          handle = await open(tempPath, resuming ? 'a' : 'w');
          await writeFile(markerPath, shaMarker);
          const deadline = Date.now() + this.syncConfig.httpsDownloadTimeout * 1000;
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              throw new Error(`Download timeout after ${this.syncConfig.httpsDownloadTimeout}s downloading ${url}`);
            }
            const next = await this.readChunkWithTimeout(reader, url, Math.min(stallMs, remaining));
            if (next.done) break;
            const value = next.value;
            await handle.write(value);
            hasher.update(value);
            downloadedSize += value.length;
          }
        } finally {
          // Cancel (not just releaseLock) so an error exit tears down the HTTP body instead of leaking the connection until GC.
          await reader.cancel().catch(() => {});
          await handle?.close();
        }

        const computedSha256 = hasher.digest('hex');

        const verification = classifyDownloadVerification(downloadedSize, computedSha256, expectedSize, expectedSha256);
        if (verification === 'size_mismatch') {
          await rm(tempPath, { force: true });
          throw new HTTPSSyncError(`Size mismatch: expected ${expectedSize}, got ${downloadedSize}`);
        }
        if (verification === 'sha256_mismatch') {
          await rm(tempPath, { force: true });
          throw new HTTPSSyncError(`sha256sum mismatch: expected ${expectedSha256}, got ${computedSha256}`);
        }

        await rename(tempPath, destPath);
        await rm(markerPath, { force: true });
        logInfo(`Successfully downloaded: ${filenameOf(destPath)} (sha256: ${computedSha256.slice(0, 16)}...)`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
        return computedSha256;
      } catch (exc) {
        if (exc instanceof HTTPSSyncError) throw exc;
        if (exc instanceof TypeError && !isFetchTransportError(exc)) {
          throw exc;
        }
        if (attempt < attempts - 1) {
          logWarning(`Download failed (attempt ${attempt + 1}/${attempts}): ${getErrorMessage(exc)}`, {
            appClassName: APP_CLASS_NAME,
            jobId: this.jobId,
          });
          await sleep(this.syncConfig.httpsRetryDelay * 1000);
        } else {
          logError(`Failed to download after ${attempts} attempts`, {
            appClassName: APP_CLASS_NAME,
            jobId: this.jobId,
          });
          throw exc;
        }
      }
    }

    throw new HTTPSSyncError(`Download not attempted (https_retry_attempts=${attempts})`);
  }

  private async loadCacheMetadata(): Promise<void> {
    if (!(await pathExists(this.metadataFile))) {
      this.cacheMetadata = {};
      return;
    }
    try {
      const content = await readFile(this.metadataFile, 'utf-8');
      this.cacheMetadata = JSON.parse(content) as CacheMetadata;
      logDebug(`Loaded cache metadata: ${Object.keys(this.cacheMetadata).length} entries`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
    } catch (exc) {
      logWarning(`Failed to load cache metadata: ${getErrorMessage(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      this.cacheMetadata = {};
    }
  }

  private async saveCacheMetadata(): Promise<void> {
    try {
      await writeFile(this.metadataFile, JSON.stringify(this.cacheMetadata, null, 2));
      logDebug(`Saved cache metadata: ${Object.keys(this.cacheMetadata).length} entries`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
    } catch (exc) {
      logError(`Failed to save cache metadata: ${getErrorMessage(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
    }
  }

  private async cleanupOldFiles(): Promise<void> {
    try {
      const currentFiles = new Set<string>();
      for (const meta of Object.values(this.cacheMetadata)) {
        if (!('filename' in meta)) {
          throw new Error(`cache metadata entry missing 'filename'`);
        }
        const name = meta.filename;
        if (name !== null && typeof name === 'object') {
          const kind = Array.isArray(name) ? 'list' : 'dict';
          throw new TypeError(`unhashable type: '${kind}'`);
        }
        if (typeof name === 'string') {
          currentFiles.add(name);
        }
      }

      let removedCount = 0;
      for (const name of await readdir(this.cacheDir)) {
        if (name.startsWith('.')) continue;
        const fullPath = join(this.cacheDir, name);
        let isRegular = false;
        try {
          const st = await stat(fullPath);
          isRegular = st.isFile();
        } catch {
          isRegular = false;
        }
        if (!isRegular) continue;
        if (!currentFiles.has(name)) {
          logInfo(`Removing orphaned cache file: ${name}`, { appClassName: APP_CLASS_NAME, jobId: this.jobId });
          await rm(fullPath, { force: true });
          removedCount += 1;
        }
      }

      if (removedCount > 0) {
        logInfo(`Cleaned up ${removedCount} orphaned cache files`, { appClassName: APP_CLASS_NAME, jobId: this.jobId });
      }
    } catch (exc) {
      logError(`Cache cleanup failed: ${getErrorMessage(exc)}`, { appClassName: APP_CLASS_NAME, jobId: this.jobId });
    }
  }

  private async readChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    url: string,
    timeoutMs: number,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    const timeoutSecs = Math.round(timeoutMs / 1000);
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Read timeout after ${timeoutSecs}s downloading ${url}`));
        reader.cancel(new Error('read timeout')).catch(() => undefined);
      }, timeoutMs);
    });
    try {
      return await Promise.race([reader.read(), timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readBodyWithReadTimeout(response: Response, url: string): Promise<string> {
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const stallMs = this.syncConfig.httpsStallTimeout * 1000;
    let text = '';
    try {
      for (;;) {
        const next = await this.readChunkWithTimeout(reader, url, stallMs);
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private getDiscoveryBaseUrl(): string {
    return this.syncConfig.discoveryBaseUrl.replace(/\/+$/, '');
  }

  private getDiscoveryManifestUrl(arch: string): string {
    return buildDiscoveryManifestUrl(this.getDiscoveryBaseUrl(), this.syncConfig.brokkrLiveVersion, arch);
  }

  private getArchCacheDir(arch: string): string {
    return buildArchCacheDir(getStorageConfig().brokkrLiveHttpsDir, arch);
  }

  private getArchitectures(): readonly string[] {
    return getDiscoveryFileConfig().architectures;
  }
}

function filenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function createBrokkrLiveHttpsSyncService(jobId = '', fetchFn?: FetchLike): BrokkrLiveHTTPSSyncService {
  return fetchFn ? new BrokkrLiveHTTPSSyncService(jobId, fetchFn) : new BrokkrLiveHTTPSSyncService(jobId);
}
