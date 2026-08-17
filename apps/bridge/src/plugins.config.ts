import bridgeHelloWorld from '@hydrahost/bridge-plugin-hello-world';
import { definePluginsConfig } from '@hydrahost/plugin-sdk';

const helloWorldEnabled = (process.env.BRIDGE_PLUGIN_HELLO_WORLD_ENABLED ?? '').trim().toLowerCase() === 'true';

const bridgePluginsConfig = definePluginsConfig([
  {
    plugin: bridgeHelloWorld,
    enabled: helloWorldEnabled,
    settings: {},
  },
]);

export default bridgePluginsConfig;
