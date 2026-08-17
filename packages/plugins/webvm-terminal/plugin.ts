import { definePlugin } from '@hydrahost/plugin-sdk';
import { z } from 'zod';

// Frontend-only plugin; this manifest joins the enabled-plugins registry (which
// gates the sidebar entry) and must never reference frontend code (./frontend-manifest).
export const webvmTerminalManifest = definePlugin({
  id: 'webvm-terminal',
  version: '0.1.0',
  // No runtime settings; the empty schema keeps the registry entry uniform
  // (`settings: {}`) with every other plugin.
  configSchema: z.object({}).describe('webvm-terminal plugin settings (none — frontend-only).'),
});

export default webvmTerminalManifest;

// Root re-export duplicates ./server: apps/api's classic (`node`) module resolution
// ignores the `exports` submap, so it must import the isolation policy from the root.
export {
  isWebvmTerminalPath,
  WEBVM_TERMINAL_COEP_HEADERS,
  WEBVM_TERMINAL_HTML,
  WEBVM_TERMINAL_ISOLATION_HEADERS,
  WEBVM_TERMINAL_PATHS,
} from './server-config';
