import type Redis from 'ioredis';

const DEFAULT_SCAN_COUNT = 100;

// Redis SCAN can legitimately return the same key more than once; the Set dedupes so callers
// mapping keys 1:1 to records don't emit duplicates.
export async function scanKeys(redis: Redis, pattern: string, count: number = DEFAULT_SCAN_COUNT): Promise<string[]> {
  const found = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    for (const key of batch) found.add(key);
  } while (cursor !== '0');
  return [...found];
}
