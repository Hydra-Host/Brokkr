export const RESULT_KEY_SUFFIX = 'work:result:';
export const PROGRESS_KEY_SUFFIX = 'work:progress:';
export const PARTIAL_KEY_SUFFIX = 'work:partial:';
export const DISPATCH_META_KEY_SUFFIX = 'work:dispatch:';
export const RESULT_CHANNEL_SUFFIX = 'work:result:channel';

export function joinZoneKey(zonePrefix: string, suffix: string): string {
  if (zonePrefix) return `${zonePrefix}:${suffix}`;
  return suffix;
}

export function resultKey(zonePrefix: string, workId: string): string {
  return joinZoneKey(zonePrefix, `${RESULT_KEY_SUFFIX}${workId}`);
}

export function progressKey(zonePrefix: string, workId: string): string {
  return joinZoneKey(zonePrefix, `${PROGRESS_KEY_SUFFIX}${workId}`);
}

export function partialKey(zonePrefix: string, workId: string): string {
  return joinZoneKey(zonePrefix, `${PARTIAL_KEY_SUFFIX}${workId}`);
}

export function dispatchMetaKey(zonePrefix: string, workId: string): string {
  return joinZoneKey(zonePrefix, `${DISPATCH_META_KEY_SUFFIX}${workId}`);
}

export function resultChannel(zonePrefix: string): string {
  return joinZoneKey(zonePrefix, RESULT_CHANNEL_SUFFIX);
}
