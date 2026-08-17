import { join } from 'node:path';

export interface PersistentStorageConfig {
  basePath: string;
}

let persistentCache: PersistentStorageConfig | undefined;

export function getPersistentStorageConfig(): PersistentStorageConfig {
  if (persistentCache === undefined) {
    persistentCache = {
      basePath: process.env.PERSISTENT_STORAGE_PATH ?? '/brokkr',
    };
  }
  return persistentCache;
}

export function resetPersistentStorageConfig(): void {
  persistentCache = undefined;
}

export function getPersistentStoragePath(subpath = ''): string {
  const basePath = getPersistentStorageConfig().basePath;
  if (!subpath) return basePath;
  return join(basePath, subpath.replace(/^\/+/, ''));
}

export interface StorageConfig {
  brokkrLiveHttpsDir: string;
  initrdBuildsDir: string;
}

let storageCache: StorageConfig | undefined;

export function getStorageConfig(): StorageConfig {
  if (storageCache === undefined) {
    storageCache = {
      brokkrLiveHttpsDir: getPersistentStoragePath('brokkr-live'),
      initrdBuildsDir: getPersistentStoragePath('initrd-builds'),
    };
  }
  return storageCache;
}

export function resetStorageConfig(): void {
  storageCache = undefined;
}
