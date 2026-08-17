import {
  BRIDGE_PLUGIN_KV,
  PLUGIN_EVENT_BUS,
  getPluginConfigToken,
  type BridgePluginKv,
  type PluginEventBus,
} from '@hydrahost/plugin-sdk';
import { Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import type { BridgeHelloWorldConfig } from '../schemas';

const PLUGIN_ID = 'bridge-hello-world';

@Injectable()
export class BridgeHelloWorldService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PLUGIN_ID);
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly events: PluginEventBus,
    @Inject(BRIDGE_PLUGIN_KV) private readonly kv: BridgePluginKv,
    @Inject(getPluginConfigToken(PLUGIN_ID)) private readonly config: BridgeHelloWorldConfig,
  ) {}

  onModuleInit(): void {
    this.logger.log(this.config.greeting);
    this.unsubscribes.push(
      this.events.on(
        'bridge.leadership.changed',
        async (payload) => {
          this.logger.log(`leadership changed: ${payload.instanceId} isLeader=${payload.isLeader}`);
          await this.kv.set('last-leadership-change', JSON.stringify(payload));
        },
        { pluginId: PLUGIN_ID },
      ),
      this.events.on(
        'bridge.saga.completed',
        async (payload) => {
          this.logger.log(`saga completed: ${payload.sagaName} plan=${payload.planId}`);
          await this.kv.set(`last-saga:${payload.sagaName}`, payload.planId, 24 * 60 * 60);
        },
        { pluginId: PLUGIN_ID },
      ),
    );
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
  }
}

@Module({
  providers: [BridgeHelloWorldService],
})
export default class BridgeHelloWorldModule {}
