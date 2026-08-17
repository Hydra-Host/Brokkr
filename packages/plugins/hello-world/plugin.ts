import { join } from 'path';

import { definePlugin } from '@hydrahost/plugin-sdk';

import { contractFragment } from './contract';
import { HelloWorldConfigSchema } from './schemas';

// Never references frontend code — that lives behind the `./frontend-manifest` subpath so apps/web doesn't pull NestJS.
export const helloWorldManifest = definePlugin({
  id: 'hello-world',
  version: '0.1.0',
  schemaName: 'plugin_hello_world',
  migrationsDir: join(__dirname, '..', 'database', 'migrations'),
  backendModule: () => import('./backend'),
  contract: contractFragment,
  configSchema: HelloWorldConfigSchema,
});

export default helloWorldManifest;
