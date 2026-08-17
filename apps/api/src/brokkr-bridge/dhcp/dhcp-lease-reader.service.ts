import { Inject, Injectable } from '@nestjs/common';
import { type DhcpLease, DhcpLeaseSchema } from '@repo/api-client';
import type Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ipv4InCidr, ipv4ToInt } from 'src/common/ip-utils';
import { REDIS_CLIENT, scanKeys } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';

/** Escape Redis glob metacharacters so a literal string can be safely interpolated into a SCAN MATCH pattern. */
const escapeGlob = (s: string): string => s.replace(/[*?[\]\\]/g, '\\$&');

// The bridge's RedisLeaseStore writes leases as plain JSON (NOT atom-enveloped) at
// `{zoneId}:dhcp:lease:{ip}` in the shared Redis; the hub only reads.
@Injectable()
export class DhcpLeaseReaderService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(DhcpLeaseReaderService.name) private readonly logger: LoggerService,
  ) {}

  async listLeasesForPrefix(zoneId: string, cidr: string): Promise<DhcpLease[]> {
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
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (error) {
        this.logger.warn(`DHCP lease ${key}: unparseable JSON, skipping (${getErrorMessage(error)})`);
        continue;
      }
      const parsed = DhcpLeaseSchema.safeParse(json);
      if (!parsed.success) {
        this.logger.warn(`DHCP lease ${key}: schema-invalid, skipping`);
        continue;
      }
      const lease = parsed.data;
      // The IP is the key suffix ({zoneId}:dhcp:lease:{ip}); a payload/key mismatch is a corrupt
      // or mis-keyed record — skip it rather than report a lease under the wrong address.
      if (lease.ip !== key.slice(key.lastIndexOf(':') + 1)) {
        this.logger.warn(`DHCP lease ${key}: payload IP ${lease.ip} != key suffix, skipping`);
        continue;
      }
      // Skip leases whose TTL elapsed but Redis hasn't evicted yet — callers expect live leases.
      if (lease.expiresAt <= nowSeconds) continue;
      if (!ipv4InCidr(lease.ip, cidr)) continue;
      leases.push(lease);
    }
    leases.sort((a, b) => (ipv4ToInt(a.ip) ?? 0) - (ipv4ToInt(b.ip) ?? 0));
    return leases;
  }
}
