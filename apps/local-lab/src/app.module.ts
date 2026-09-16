import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';

import { AuditModule } from './audit/audit.module';
import { BuildModule } from './build/build.module';
import { AuditInterceptor } from './common/audit.interceptor';
import { LabAuthGuard } from './common/lab-auth';
import { LabExceptionFilter } from './common/lab-exception.filter';
import { DatastoreModule } from './datastore/datastore.module';
import { DbModule } from './db/db.module';
import { DocsModule } from './docs/docs.module';
import { FleetModule } from './fleet/fleet.module';
import { HealthModule } from './health/health.module';
import { HubModule } from './hub/hub.module';
import { LayersModule } from './layers/layers.module';
import { LedgerModule } from './ledger/ledger.module';
import { QueuesModule } from './queues/queues.module';
import { RunsModule } from './runs/runs.module';
import { RuntimeModule } from './runtime/runtime.module';
import { ServicesModule } from './services/services.module';
import { StackModule } from './stack/stack.module';
import { StatusModule } from './status/status.module';
import { StorageModule } from './storage/storage.module';
import { SudoModule } from './sudo/sudo.module';
import { TestModule } from './test/test.module';
import { ZonesModule } from './zones/zones.module';

const webDistRoot = { rootPath: join(__dirname, '../..', 'local-lab-web', 'dist'), exclude: ['/api/{*path}'] };

const staticImports = process.env.NODE_ENV === 'production' ? [ServeStaticModule.forRoot(webDistRoot)] : [];

@Module({
  imports: [
    ...staticImports,
    DbModule,
    LedgerModule,
    RunsModule,
    StackModule,
    SudoModule,
    ServicesModule,
    TestModule,
    FleetModule,
    LayersModule,
    BuildModule,
    DatastoreModule,
    QueuesModule,
    RuntimeModule,
    ZonesModule,
    HubModule,
    StatusModule,
    StorageModule,
    DocsModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: LabAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: LabExceptionFilter },
  ],
})
export class AppModule {}
