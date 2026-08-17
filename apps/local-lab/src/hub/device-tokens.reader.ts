import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '../common/errors';
import type { DeviceTokenEventPage, DeviceTokenPage, DeviceTokenRow } from '../contract';
import { PgService } from '../datastore/pg.service';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import {
  DEVICE_TOKEN_EVENTS_SQL,
  DEVICE_TOKENS_SQL,
  DeviceTokenEventSqlRowSchema,
  deviceTokenLastUsedKey,
  type DeviceTokenSqlRow,
  DeviceTokenSqlRowSchema,
} from './hub-sql';

export interface DeviceTokenQuery {
  deviceId: string | null;
  status: string | null;
  limit: number;
  offset: number;
}

@Injectable()
export class DeviceTokensReaderService {
  private readonly log = new Logger(DeviceTokensReaderService.name);

  constructor(
    private readonly pg: PgService,
    private readonly connections: RedisConnectionsService,
  ) {}

  async list(query: DeviceTokenQuery): Promise<DeviceTokenPage> {
    let rows: DeviceTokenSqlRow[];
    let skipped: number;
    try {
      const read = await this.pg.readTyped(
        DEVICE_TOKENS_SQL,
        [query.deviceId, query.status, query.limit, query.offset],
        DeviceTokenSqlRowSchema,
      );
      rows = read.rows;
      skipped = read.skipped;
      if (skipped > 0) this.log.warn(`device tokens: skipped ${skipped} unreadable row(s)`);
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`device token read failed: ${readError}`);
      return { rows: [], skipped: 0, readError, recencyReadError: null };
    }

    const live = await this.liveSentinels(rows.map((row) => row.id));
    return {
      rows: rows.map((row) => this.toRow(row, live.byToken)),
      skipped,
      readError: null,
      recencyReadError: live.readError,
    };
  }

  async events(tokenId: string, limit: number, offset: number): Promise<DeviceTokenEventPage> {
    try {
      const { rows, skipped } = await this.pg.readTyped(
        DEVICE_TOKEN_EVENTS_SQL,
        [tokenId, limit, offset],
        DeviceTokenEventSqlRowSchema,
      );
      return {
        rows: rows.map((row) => ({
          id: row.id,
          event: row.event,
          actor: row.actor,
          ip: row.ip,
          userAgent: row.userAgent,
          createdAtMs: row.createdAt,
        })),
        skipped,
        readError: null,
      };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`device token audit read failed for ${tokenId}: ${readError}`);
      return { rows: [], skipped: 0, readError };
    }
  }

  private toRow(row: DeviceTokenSqlRow, live: Map<string, boolean> | null): DeviceTokenRow {
    return {
      id: row.id,
      displayId: row.displayId,
      deviceId: row.deviceId,
      deploymentId: row.deploymentId,
      context: row.context,
      status: row.status,
      rotationGeneration: row.rotationGeneration,
      expiresAtMs: row.expiresAt,
      lastUsedAtMs: row.lastUsedAt,
      lastUsedIp: row.lastUsedIp,
      // null, not false: an unread sentinel must never assert the token is idle, and a probe that
      // ran can still fail for one key — absent from the map means unread, not measured-absent
      usedWithinThrottleWindow: live === null ? null : (live.get(row.id) ?? null),
      revokedAtMs: row.revokedAt,
      revokedReason: row.revokedReason,
      issuedBy: row.issuedBy,
      createdAtMs: row.createdAt,
    };
  }

  private async liveSentinels(
    tokenIds: string[],
  ): Promise<{ byToken: Map<string, boolean> | null; readError: string | null }> {
    if (tokenIds.length === 0) return { byToken: new Map(), readError: null };
    try {
      // hub-written and global, so it is on the view client rather than a zone-prefixed spoke key
      const client = this.connections.client('view');
      const pipeline = client.multi();
      for (const id of tokenIds) pipeline.exists(deviceTokenLastUsedKey(id));
      const replies = await pipeline.exec();
      if (replies === null) throw new Error('redis returned no replies for the last-used probe');

      const byToken = new Map<string, boolean>();
      let unanswered = 0;
      tokenIds.forEach((id, index) => {
        const entry = replies[index];
        if (!entry) {
          unanswered += 1;
          return;
        }
        const [error, value] = entry;
        if (error) {
          unanswered += 1;
          return;
        }
        byToken.set(id, Number(value) === 1);
      });
      if (unanswered > 0) this.log.warn(`device token last-used probe: ${unanswered} key(s) unanswered`);
      return { byToken, readError: null };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`device token last-used probe failed: ${readError}`);
      return { byToken: null, readError };
    }
  }
}
