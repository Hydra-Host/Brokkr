import { defineFrontendPlugin } from '@hydrahost/plugin-sdk';

export const webvmTerminalFrontendManifest = defineFrontendPlugin({
  id: 'webvm-terminal',
  version: '0.1.0',
  frontend: () => import('./frontend'),
});

export default webvmTerminalFrontendManifest;
