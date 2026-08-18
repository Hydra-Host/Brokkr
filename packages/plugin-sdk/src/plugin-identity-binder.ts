import type { PluginVerifiedApiKey } from './plugin-auth-client';

export const PLUGIN_IDENTITY_BINDER = Symbol.for('@hydrahost/plugin-sdk/IDENTITY_BINDER');

export interface PluginIdentityBinder {
  bindVerifiedApiKey(key: PluginVerifiedApiKey): Promise<void>;
}
