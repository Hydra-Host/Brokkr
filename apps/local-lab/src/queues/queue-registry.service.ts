import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import { SingleFlightCache } from '../common/single-flight-cache';
import type { QueueKind, QueueRef, QueueSummary } from '../contract';
import { ZoneRegistryService } from '../datastore/zone-registry.service';
import { QueueReaderService } from './queue-reader.service';
import { HUB_QUEUE_PREFIX, RESULTS_QUEUE_NAME, RESULTS_QUEUE_PREFIX, SAGA_QUEUE_NAMES } from './saga-topology';

const KIND_ORDER: readonly QueueKind[] = ['saga', 'results', 'hub'];

// well above the inspector's 2s poll, so a multi-pattern SCAN sweep of a shared keyspace runs once per
// several polls instead of once per poll. Only which rows exist is cached this long; counts are per request.
const INVENTORY_TTL_MS = 15_000;

function sagaPrefixOf(key: string, name: string): string | null {
  const suffix = `:${name}:meta`;
  if (!key.endsWith(suffix)) return null;
  const prefix = key.slice(0, -suffix.length);
  return prefix.length > 0 ? prefix : null;
}

function hubNameOf(key: string): string | null {
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== HUB_QUEUE_PREFIX || parts[2] !== 'meta') return null;
  return parts[1].length > 0 ? parts[1] : null;
}

function compareRefs(a: QueueRef, b: QueueRef): number {
  return (
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.prefix.localeCompare(b.prefix) ||
    a.name.localeCompare(b.name)
  );
}

@Injectable()
export class QueueRegistryService {
  private readonly log = new Logger(QueueRegistryService.name);

  private readonly inventoryCache = new SingleFlightCache<QueueRef[]>({
    load: () => this.discover(),
    ttlMs: INVENTORY_TTL_MS,
  });

  constructor(
    private readonly zoneRegistry: ZoneRegistryService,
    private readonly reader: QueueReaderService,
  ) {}

  async inventory(): Promise<QueueRef[]> {
    return this.inventoryCache.get();
  }

  /** Allowlist gate: a prefix/name off a request must resolve here before anything touches Redis with it. */
  async resolve(prefix: string, name: string): Promise<QueueRef | null> {
    const inventory = await this.inventory();
    return inventory.find((ref) => ref.prefix === prefix && ref.name === name) ?? null;
  }

  async list(): Promise<QueueSummary[]> {
    const inventory = await this.inventory();
    return Promise.all(inventory.map((ref) => this.reader.summary(ref)));
  }

  private async discover(): Promise<QueueRef[]> {
    const found = new Map<string, QueueRef>();
    const add = (ref: QueueRef): void => {
      const key = `${ref.prefix}:${ref.name}`;
      if (!found.has(key)) found.set(key, ref);
    };

    for (const zoneId of await this.zoneRegistry.listZoneIds()) {
      for (const name of SAGA_QUEUE_NAMES) add({ prefix: zoneId, name, kind: 'saga' });
    }

    // saga names claim their key first: an orphan bull:lifecycle queue is a mis-prefixed spoke, not a hub queue.
    for (const name of SAGA_QUEUE_NAMES) {
      for (const key of await this.scan(`*:${name}:meta`)) {
        const prefix = sagaPrefixOf(key, name);
        if (prefix) add({ prefix, name, kind: 'saga' });
      }
    }

    if (await this.exists(RESULTS_QUEUE_PREFIX, RESULTS_QUEUE_NAME)) {
      add({ prefix: RESULTS_QUEUE_PREFIX, name: RESULTS_QUEUE_NAME, kind: 'results' });
    }

    for (const key of await this.scan(`${HUB_QUEUE_PREFIX}:*:meta`)) {
      const name = hubNameOf(key);
      if (name) add({ prefix: HUB_QUEUE_PREFIX, name, kind: 'hub' });
    }

    return [...found.values()].sort(compareRefs);
  }

  private async scan(match: string): Promise<string[]> {
    try {
      return await this.reader.scanMetaKeys(match);
    } catch (error) {
      this.log.debug(`queue discovery scan ${match} failed: ${getErrorMessage(error)}`);
      return [];
    }
  }

  private async exists(prefix: string, name: string): Promise<boolean> {
    try {
      return await this.reader.queueExists(prefix, name);
    } catch (error) {
      this.log.debug(`queue existence check ${prefix}:${name} failed: ${getErrorMessage(error)}`);
      return false;
    }
  }
}
