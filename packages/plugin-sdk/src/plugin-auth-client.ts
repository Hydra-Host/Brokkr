export const PLUGIN_AUTH_CLIENT = Symbol.for('@hydrahost/plugin-sdk/AUTH_CLIENT');

export interface PluginVerifiedApiKey {
  id: string;
  referenceId: string;
  name?: string | null;
}

export type PluginVerifyApiKeyResult =
  | { valid: true; key: PluginVerifiedApiKey }
  | { valid: false; error?: { code?: string; message?: string } | null };

export interface PluginAuthClient {
  verifyApiKey(key: string): Promise<PluginVerifyApiKeyResult>;
}
