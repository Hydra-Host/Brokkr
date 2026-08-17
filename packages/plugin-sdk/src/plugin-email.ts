import type { EmailMessage } from './email-transport';

export const PLUGIN_EMAIL = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_EMAIL');

export interface PluginEmail {
  send(message: EmailMessage): Promise<void>;
}
