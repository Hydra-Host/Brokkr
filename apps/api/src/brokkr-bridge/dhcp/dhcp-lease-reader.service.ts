import { Inject, Injectable } from '@nestjs/common';
import { type DhcpLease, DhcpLeaseSchema } from '@repo/api-client';
import { ipInCidr, ipv4ToInt } from '@repo/utils';
import type Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT, scanKeys } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';

/** Escape Redis glob metacharacters so a literal string can be safely interpolated into a SCAN MATCH pattern. */
const escapeGlob = (s: string): string => s.replace(/[*?[\]\\]/g, '\\$&');

// Long enough for any leader to complete a reconcile pass and drain the marker; after that a
// restarting bridge hydrates from Redis, where the lease key is already gone.
const REVOKE_MARKER_TTL_SECONDS = 300;

// Leases are plain JSON (NOT atom-enveloped); revoking writes a marker the bridge drains on
// reconcile. Both key shapes are a bridge wire contract (see bridge redis-keys.ts).
@Injectable()
export class DhcpLeaseReaderService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(DhcpLeaseReaderService.name) private readonly logger: LoggerService,
  ) {}

  async listLeasesForPrefix(zoneId: string, cidr: string): Promise<DhcpLease[]> {
    const leases = await this.listLeasesForZone(zoneId);
    return leases.filter((lease) => ipInCidr(lease.ip, cidr));
  }

  // Zone-wide rollup: the same live leases listLeasesForPrefix narrows by CIDR. Exists so a
  // caller that only knows the zone (no prefix) can read the whole lease table in one pass.
  async listLeasesForZone(zoneId: string): Promise<DhcpLease[]> {
    // Escape glob metacharacters in zoneId so the SCAN pattern matches literally.
    const keys = await scanKeys(this.redis, `${escapeGlob(zoneId)}:dhcp:lease:*`);
    if (keys.length === 0) return [];
    // One MGET instead of N round-trips; ioredis returns (string | null)[] aligned to `keys`,
    // and the raw === null check below already handles missing entries.
    const raws = await this.redis.mget(...keys);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const leases: DhcpLease[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const raw = raws[i];
      if (raw === null || raw === undefined) continue;
      const lease = this.parseLease(key, raw);
      if (lease === null) continue;
      // Skip leases whose TTL elapsed but Redis hasn't evicted yet — callers expect live leases.
      if (lease.expiresAt <= nowSeconds) continue;
      leases.push(lease);
    }
    leases.sort((a, b) => (ipv4ToInt(a.ip) ?? 0) - (ipv4ToInt(b.ip) ?? 0));
    return leases;
  }

  /** The revocation marker is load-bearing: the engine only re-reads the store on hydrate, so
   * deleting the key alone leaves a running server honoring the address from memory. */
  async revokeLease(zoneId: string, ip: string): Promise<DhcpLease | null> {
    const leaseKey = `${zoneId}:dhcp:lease:${ip}`;
    const raw = await this.redis.get(leaseKey);
    if (raw === null) return null;
    const removed = this.parseLease(leaseKey, raw);
    if (removed === null) return null;

    // Marker before delete: if the engine renews between the two writes it re-creates the
    // key, and only the marker guarantees the address is still dropped from memory.
    await this.redis.set(`${zoneId}:dhcp:lease-revoke:${ip}`, '1', 'EX', REVOKE_MARKER_TTL_SECONDS);
    await this.redis.del(leaseKey);
    this.logger.log(`DHCP lease ${ip} revoked in zone ${zoneId}`);
    return removed;
  }

  // A corrupt record must warn identically on both paths: a silent null here reaches the
  // operator as a bare 404 with nothing in the log explaining why the lease was unreadable.
  private parseLease(key: string, raw: string): DhcpLease | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.logger.warn(`DHCP lease ${key}: unparseable JSON, skipping (${getErrorMessage(error)})`);
      return null;
    }
    const parsed = DhcpLeaseSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`DHCP lease ${key}: schema-invalid, skipping`);
      return null;
    }
    // The IP is the key suffix ({zoneId}:dhcp:lease:{ip}); a payload/key mismatch is a corrupt
    // or mis-keyed record — skip it rather than report a lease under the wrong address.
    if (parsed.data.ip !== key.slice(key.lastIndexOf(':') + 1)) {
      this.logger.warn(`DHCP lease ${key}: payload IP ${parsed.data.ip} != key suffix, skipping`);
      return null;
    }
    return parsed.data;
  }
}
