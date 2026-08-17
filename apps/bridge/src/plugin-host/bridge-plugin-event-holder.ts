import type { BrokkrEventMap, BrokkrEventName, PluginEventBus } from '@hydrahost/plugin-sdk';

let bus: PluginEventBus | null = null;

export function setBridgePluginEventBus(value: PluginEventBus): void {
  bus = value;
}

export function getBridgePluginEventBus(): PluginEventBus | null {
  return bus;
}

export function resetBridgePluginEventBusForTests(): void {
  bus = null;
}

export function emitBridgePluginEvent<E extends BrokkrEventName>(event: E, payload: BrokkrEventMap[E]): void {
  bus?.emit(event, payload);
}
