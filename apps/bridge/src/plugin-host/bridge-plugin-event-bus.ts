import {
  HOST_PLUGIN_ID,
  type BrokkrEventHandler,
  type BrokkrEventMap,
  type BrokkrEventName,
  type PluginEventBus,
} from '@hydrahost/plugin-sdk';

import { getErrorMessage } from '../common/error-utils.js';
import { logWarning } from '../logger/logger.service.js';

export interface BridgePluginEventBusLogger {
  warn(message: string): void;
}

interface Registration {
  handler(payload: BrokkrEventMap[BrokkrEventName]): void | Promise<void>;
  pluginId: string;
}

function defaultBusLogger(): BridgePluginEventBusLogger {
  return { warn: (message) => void logWarning(message, { jobId: '' }) };
}

export class HostBridgePluginEventBus implements PluginEventBus {
  private readonly registrations = new Map<BrokkrEventName, Set<Registration>>();

  constructor(private readonly logger: BridgePluginEventBusLogger = defaultBusLogger()) {}

  emit<E extends BrokkrEventName>(event: E, payload: BrokkrEventMap[E]): void {
    const registrations = this.registrations.get(event);
    if (registrations === undefined) return;
    for (const registration of [...registrations]) {
      try {
        const result = registration.handler(payload);
        if (result instanceof Promise) {
          result.catch((error) => this.warnHandlerFailure(registration.pluginId, event, error));
        }
      } catch (error) {
        this.warnHandlerFailure(registration.pluginId, event, error);
      }
    }
  }

  on<E extends BrokkrEventName>(event: E, handler: BrokkrEventHandler<E>, opts?: { pluginId?: string }): () => void {
    let registrations = this.registrations.get(event);
    if (registrations === undefined) {
      registrations = new Set();
      this.registrations.set(event, registrations);
    }
    const registration: Registration = {
      handler,
      pluginId: opts?.pluginId ?? HOST_PLUGIN_ID,
    };
    registrations.add(registration);
    return () => {
      registrations.delete(registration);
    };
  }

  off<E extends BrokkrEventName>(event: E, handler: BrokkrEventHandler<E>): void {
    const registrations = this.registrations.get(event);
    if (registrations === undefined) return;
    for (const registration of registrations) {
      if (registration.handler === handler) {
        registrations.delete(registration);
      }
    }
  }

  private warnHandlerFailure(pluginId: string, event: string, error: unknown): void {
    this.logger.warn(
      `bridge plugin event handler failed (plugin=${pluginId}, event=${event}): ${getErrorMessage(error)}`,
    );
  }
}
