import { getErrorMessage } from '../../common/error-utils.js';
import { dhcpLease, dhcpLeasePattern, dhcpLeaseRevoke, dhcpLeaseRevokePattern } from '../../common/redis/redis-keys.js';

import type { LeaseRecord } from './lease-record.js';
import { leaseRecordSchema } from './lease-record.schema.js';
import type { LeaseStore } from './lease-store.js';

export interface RedisLeaseCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<unknown>;
  delete(key: string): Promise<number>;
  scan(pattern: string): Promise<string[]>;
}

export interface RedisLeaseStoreLogger {
  warn(message: string): void;
}

export class RedisLeaseStore implements LeaseStore {
  constructor(
    private readonly redis: () => RedisLeaseCache,
    private readonly now: () => number,
    private readonly logger: RedisLeaseStoreLogger,
  ) {}

  async loadAll(): Promise<LeaseRecord[]> {
    const keys = await this.redis().scan(dhcpLeasePattern());
    const now = this.now();
    const raws = await Promise.all(keys.map((key) => this.redis().get(key)));
    const survivors: LeaseRecord[] = [];
    const expired: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const raw = raws[i];
      if (raw === null || raw === undefined) continue;
      const parsed = this.parseRecord(keys[i]!, raw);
      if (parsed === null) continue;
      if (dhcpLease(parsed.ip) !== keys[i]) {
        this.logger.warn(`DHCP lease ${keys[i]}: payload IP ${parsed.ip} ≠ key suffix, skipping`);
        continue;
      }
      if (parsed.expiresAt <= now) {
        expired.push(keys[i]!);
        continue;
      }
      survivors.push(parsed);
    }
    await Promise.all(expired.map((key) => this.redis().delete(key)));
    return survivors;
  }

  async put(lease: LeaseRecord): Promise<void> {
    const valid = leaseRecordSchema.parse(lease);
    const ttl = Math.max(1, Math.ceil(lease.expiresAt - this.now()));
    await this.redis().set(dhcpLease(lease.ip), JSON.stringify(valid), ttl);
  }

  async delete(lease: LeaseRecord): Promise<void> {
    await this.redis().delete(dhcpLease(lease.ip));
  }

  async takeRevocations(): Promise<string[]> {
    const keys = await this.redis().scan(dhcpLeaseRevokePattern());
    if (keys.length === 0) return [];
    const ips: string[] = [];
    for (const key of keys) {
      const ip = key.slice(key.lastIndexOf(':') + 1);
      // Clear the marker before acting: a revocation replayed after the address has
      // been handed to a new client would evict that client's live lease instead.
      if (dhcpLeaseRevoke(ip) !== key) {
        this.logger.warn(`DHCP revocation ${key}: unparseable key, dropping`);
      } else {
        ips.push(ip);
      }
      await this.redis().delete(key);
    }
    return ips;
  }

  async pruneExpired(nowSeconds: number): Promise<number> {
    const keys = await this.redis().scan(dhcpLeasePattern());
    const raws = await Promise.all(keys.map((key) => this.redis().get(key)));
    const expired: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const raw = raws[i];
      if (raw === null || raw === undefined) continue;
      const parsed = this.parseRecord(keys[i]!, raw);
      if (parsed === null) continue;
      if (parsed.expiresAt <= nowSeconds) {
        expired.push(keys[i]!);
      }
    }
    await Promise.all(expired.map((key) => this.redis().delete(key)));
    return expired.length;
  }

  private parseRecord(key: string, raw: string): LeaseRecord | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.logger.warn(`DHCP lease ${key}: unparseable JSON, skipping (${getErrorMessage(error)})`);
      return null;
    }
    const result = leaseRecordSchema.safeParse(json);
    if (!result.success) {
      this.logger.warn(`DHCP lease ${key}: schema-invalid, skipping (${result.error.message})`);
      return null;
    }
    return {
      ip: result.data.ip,
      mac: result.data.mac,
      hostname: result.data.hostname ?? null,
      expiresAt: result.data.expiresAt,
    };
  }
}
