import type { DeviceMutation, MutationUpserts } from './collectors/collector.types';

// Later writer wins on the shallow merges (handlers must not emit `null` unless null is intended); duplicate array entries are resolved in `applyMutations`.
export function mergeMutations(buffered: DeviceMutation, next: DeviceMutation): DeviceMutation {
  if (next.deviceUpdate) {
    buffered.deviceUpdate = { ...(buffered.deviceUpdate ?? {}), ...next.deviceUpdate };
  }

  if (next.serverUpdate) {
    buffered.serverUpdate = { ...(buffered.serverUpdate ?? {}), ...next.serverUpdate };
  }

  if (next.upserts) {
    buffered.upserts ??= {};
    mergeArrayBucket(buffered.upserts, next.upserts, 'cpus');
    mergeArrayBucket(buffered.upserts, next.upserts, 'gpus');
    mergeArrayBucket(buffered.upserts, next.upserts, 'storageDrives');
    mergeArrayBucket(buffered.upserts, next.upserts, 'interfaces');
    mergeArrayBucket(buffered.upserts, next.upserts, 'firmwares');
    mergeArrayBucket(buffered.upserts, next.upserts, 'pciDevices');
    mergeArrayBucket(buffered.upserts, next.upserts, 'uefiBootEntries');
    mergeArrayBucket(buffered.upserts, next.upserts, 'nvlinkEdges');
    mergeArrayBucket(buffered.upserts, next.upserts, 'natMappings');

    if (next.upserts.memoryConfig) buffered.upserts.memoryConfig = next.upserts.memoryConfig;
    if (next.upserts.solConfig) buffered.upserts.solConfig = next.upserts.solConfig;
  }

  if (next.warnings && next.warnings.length > 0) {
    buffered.warnings = [...(buffered.warnings ?? []), ...next.warnings];
  }

  return buffered;
}

function mergeArrayBucket<K extends keyof MutationUpserts>(
  buffered: MutationUpserts,
  next: MutationUpserts,
  key: K,
): void {
  const nextArr = next[key];
  if (!Array.isArray(nextArr) || nextArr.length === 0) return;
  const bufferedArr = buffered[key];
  if (Array.isArray(bufferedArr)) {
    (buffered[key] as unknown[]) = [...bufferedArr, ...nextArr];
  } else {
    (buffered[key] as unknown[]) = [...nextArr];
  }
}

export function countUpserts(upserts: MutationUpserts | undefined): Record<string, number> {
  if (!upserts) return {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(upserts)) {
    if (Array.isArray(value)) counts[key] = value.length;
    else if (value != null) counts[key] = 1;
  }
  return counts;
}
