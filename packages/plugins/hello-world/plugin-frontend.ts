import { defineFrontendPlugin } from '@hydrahost/plugin-sdk';

import { contractFragment } from './contract';

// Never references backend NestJS/Prisma code — keeps apps/web's bundle free of those deps.
export const helloWorldFrontendManifest = defineFrontendPlugin({
  id: 'hello-world',
  version: '0.1.0',
  frontend: () => import('./frontend'),
  contract: contractFragment,
});

export default helloWorldFrontendManifest;
