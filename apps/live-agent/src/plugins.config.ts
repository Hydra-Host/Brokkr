import bridgeHelloWorldAgent from '@hydrahost/bridge-plugin-hello-world/agent';
import { defineAgentPluginsConfig } from '@hydrahost/plugin-sdk';

const helloWorldEnabled = (process.env.BRIDGE_PLUGIN_HELLO_WORLD_ENABLED ?? '').trim().toLowerCase() === 'true';

const agentPluginsConfig = defineAgentPluginsConfig([
  {
    plugin: bridgeHelloWorldAgent,
    enabled: helloWorldEnabled,
  },
]);

export default agentPluginsConfig;
