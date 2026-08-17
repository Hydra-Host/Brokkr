// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BrokkrEventMap {}

export type BrokkrEventName = keyof BrokkrEventMap & string;

export type BrokkrEventHandler<E extends BrokkrEventName> = (payload: BrokkrEventMap[E]) => void | Promise<void>;

export const PLUGIN_EVENT_BUS = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_EVENT_BUS');

export const HOST_PLUGIN_ID = 'host';

/** Handler failures are isolated per handler — catch and log inside yours. Unsubscribe (via `on()`'s return) in `onModuleDestroy` to avoid leaks. */
export interface PluginEventBus {
  emit<E extends BrokkrEventName>(event: E, payload: BrokkrEventMap[E]): void;

  on<E extends BrokkrEventName>(event: E, handler: BrokkrEventHandler<E>, opts?: { pluginId?: string }): () => void;

  off<E extends BrokkrEventName>(event: E, handler: BrokkrEventHandler<E>): void;
}
