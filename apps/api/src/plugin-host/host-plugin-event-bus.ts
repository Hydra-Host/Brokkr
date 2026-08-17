import type { BrokkrEventHandler, BrokkrEventMap, BrokkrEventName, PluginEventBus } from '@hydrahost/plugin-sdk';
import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ContextService } from '../common/context/context.service';
import { Logger } from '../common/decorators/logger.decorator';
import { getErrorMessage } from '../common/error-utils';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class HostPluginEventBus implements PluginEventBus {
  private readonly wrappedHandlers = new Map<
    BrokkrEventName,
    WeakMap<BrokkrEventHandler<BrokkrEventName>, ((payload: unknown) => void)[]>
  >();

  constructor(
    private readonly emitter: EventEmitter2,
    @Logger(HostPluginEventBus.name) private readonly logger: LoggerService,
    @Optional() private readonly context?: ContextService,
  ) {}

  emit<E extends BrokkrEventName>(event: E, payload: BrokkrEventMap[E]): void {
    this.emitter.emit(event, payload);
  }

  on<E extends BrokkrEventName>(event: E, handler: BrokkrEventHandler<E>, opts?: { pluginId?: string }): () => void {
    const pluginId = opts?.pluginId ?? 'unknown';
    const wrapped = (payload: unknown): void => {
      try {
        const result = handler(payload as BrokkrEventMap[E]);
        if (result instanceof Promise) {
          result.catch((error) => {
            this.logger.error(
              `Handler for "${event}" rejected (pluginId=${pluginId} requestId=${this.requestId}): ${getErrorMessage(error)}`,
              error instanceof Error ? error.stack : undefined,
            );
          });
        }
      } catch (error) {
        this.logger.error(
          `Handler for "${event}" threw (pluginId=${pluginId} requestId=${this.requestId}): ${getErrorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    };

    let perEvent = this.wrappedHandlers.get(event);
    if (!perEvent) {
      perEvent = new WeakMap();
      this.wrappedHandlers.set(event, perEvent);
    }
    const key = handler as BrokkrEventHandler<BrokkrEventName>;
    const wrappedList = perEvent.get(key);
    if (wrappedList) {
      wrappedList.push(wrapped);
    } else {
      perEvent.set(key, [wrapped]);
    }
    this.emitter.on(event, wrapped);

    return () => this.removeWrapped(event, key, wrapped);
  }

  private get requestId(): string {
    return this.context?.requestId ?? 'none';
  }

  off<E extends BrokkrEventName>(event: E, handler: BrokkrEventHandler<E>): void {
    const perEvent = this.wrappedHandlers.get(event);
    const key = handler as BrokkrEventHandler<BrokkrEventName>;
    const wrappedList = perEvent?.get(key);
    if (!perEvent || !wrappedList || wrappedList.length === 0) return;
    const wrapped = wrappedList.shift();
    if (wrapped) this.emitter.off(event, wrapped);
    if (wrappedList.length === 0) perEvent.delete(key);
  }

  private removeWrapped(
    event: BrokkrEventName,
    key: BrokkrEventHandler<BrokkrEventName>,
    wrapped: (payload: unknown) => void,
  ): void {
    const perEvent = this.wrappedHandlers.get(event);
    const wrappedList = perEvent?.get(key);
    if (!perEvent || !wrappedList) return;
    const index = wrappedList.indexOf(wrapped);
    if (index === -1) return;
    wrappedList.splice(index, 1);
    this.emitter.off(event, wrapped);
    if (wrappedList.length === 0) perEvent.delete(key);
  }
}
