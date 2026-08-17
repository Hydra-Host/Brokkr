import type { TelegrafCache } from './telegraf-factory.js';

export class TelegrafCacheNotBoundError extends Error {
  constructor() {
    super(
      'Telegraf cache holder not populated; AppModule must call setTelegrafCache ' +
        'via an OnApplicationBootstrap hook before the telegraf config writer ticks.',
    );
    this.name = 'TelegrafCacheNotBoundError';
  }
}

let cache: TelegrafCache | null = null;

export function setTelegrafCache(value: TelegrafCache): void {
  cache = value;
}

export function getTelegrafCacheOrThrow(): TelegrafCache {
  if (cache === null) {
    throw new TelegrafCacheNotBoundError();
  }
  return cache;
}

export function resetTelegrafCacheForTests(): void {
  cache = null;
}
