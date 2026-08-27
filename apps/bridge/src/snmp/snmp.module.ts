import { Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { SnmpClient } from './client.js';
import { getSnmpEngine, SnmpEngine } from './engine.js';

@Module({
  providers: [
    { provide: SnmpEngine, useFactory: () => getSnmpEngine() },
    { provide: SnmpClient, useFactory: () => new SnmpClient() },
  ],
  exports: [SnmpEngine, SnmpClient],
})
export class SnmpModule implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(private readonly engine: SnmpEngine) {}

  async onApplicationBootstrap(): Promise<void> {
    // SNMP is opt-in via SNMP_ENABLED=true (default off): engine startup is heavy; the
    // Engine/Client providers stay wired so DI is unaffected — the engine just isn't started.
    if (process.env.SNMP_ENABLED === 'true') {
      await this.engine.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.engine.isClosed()) await this.engine.close();
  }
}
