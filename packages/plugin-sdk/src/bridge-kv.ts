export const BRIDGE_PLUGIN_KV = Symbol.for('@hydrahost/plugin-sdk/BRIDGE_PLUGIN_KV');

export interface BridgePluginKv {
  get(key: string): Promise<string | null>;

  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  delete(key: string): Promise<boolean>;

  scan(pattern: string): Promise<string[]>;
}
