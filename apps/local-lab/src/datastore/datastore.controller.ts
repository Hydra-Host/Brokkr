import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { DbMigrationsService } from './db-migrations.service';
import { PgService } from './pg.service';
import { RedisService } from './redis.service';
import { ThanosService } from './thanos.service';

@Controller()
export class DatastoreController {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly thanos: ThanosService,
    private readonly dbMigrations: DbMigrationsService,
  ) {}

  @TsRestHandler(contract.listPgTables)
  pgTables() {
    return tsRestHandler(contract.listPgTables, async () => ({
      status: 200 as const,
      body: await this.pg.listTables(),
    }));
  }

  @TsRestHandler(contract.getPgColumns)
  pgColumns() {
    return tsRestHandler(contract.getPgColumns, async ({ params }) => ({
      status: 200 as const,
      body: await this.pg.getColumns(params.schema, params.table),
    }));
  }

  @TsRestHandler(contract.getPgRows)
  pgRows() {
    return tsRestHandler(contract.getPgRows, async ({ params, query }) => ({
      status: 200 as const,
      body: await this.pg.getRows(params.schema, params.table, {
        limit: query.limit,
        offset: query.offset,
        orderBy: query.orderBy,
        orderDir: query.orderDir,
      }),
    }));
  }

  @TsRestHandler(contract.runPgQuery)
  @LabRoute({ capability: 'host-exec' })
  pgQuery() {
    return tsRestHandler(contract.runPgQuery, async ({ body }) => ({
      status: 200 as const,
      body: await this.pg.runQuery(body.sql),
    }));
  }

  @TsRestHandler(contract.getDbMigrations)
  pgMigrations() {
    return tsRestHandler(contract.getDbMigrations, async () => ({
      status: 200 as const,
      body: await this.dbMigrations.status(),
    }));
  }

  @TsRestHandler(contract.getRedisInfo)
  redisInfo() {
    return tsRestHandler(contract.getRedisInfo, async () => ({
      status: 200 as const,
      body: await this.redis.info(),
    }));
  }

  @TsRestHandler(contract.scanRedisKeys)
  redisKeys() {
    return tsRestHandler(contract.scanRedisKeys, async ({ query }) => ({
      status: 200 as const,
      body: await this.redis.scan(query.cursor, query.match, query.count),
    }));
  }

  @TsRestHandler(contract.getRedisValue)
  redisValue() {
    return tsRestHandler(contract.getRedisValue, async ({ query }) => ({
      status: 200 as const,
      body: await this.redis.value(query.key),
    }));
  }

  @TsRestHandler(contract.getThanosStatus)
  thanosStatus() {
    return tsRestHandler(contract.getThanosStatus, async () => ({
      status: 200 as const,
      body: await this.thanos.status(),
    }));
  }

  @TsRestHandler(contract.listThanosMetrics)
  thanosMetrics() {
    return tsRestHandler(contract.listThanosMetrics, async ({ query }) => ({
      status: 200 as const,
      body: await this.thanos.metrics(query.match),
    }));
  }

  @TsRestHandler(contract.queryThanos)
  thanosQuery() {
    return tsRestHandler(contract.queryThanos, async ({ query }) => ({
      status: 200 as const,
      body: await this.thanos.query(query.query, query.time),
    }));
  }

  @TsRestHandler(contract.queryThanosRange)
  thanosQueryRange() {
    return tsRestHandler(contract.queryThanosRange, async ({ query }) => ({
      status: 200 as const,
      body: await this.thanos.queryRange(query.query, query.start, query.end, query.step),
    }));
  }
}
