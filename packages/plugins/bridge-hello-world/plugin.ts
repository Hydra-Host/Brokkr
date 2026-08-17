import { definePlugin } from '@hydrahost/plugin-sdk';

import { BridgeHelloWorldConfigSchema } from './schemas';

export const bridgeHelloWorldManifest = definePlugin({
  id: 'bridge-hello-world',
  version: '0.1.0',
  bridgeModule: () => import('./backend'),
  configSchema: BridgeHelloWorldConfigSchema,
});

export default bridgeHelloWorldManifest;
