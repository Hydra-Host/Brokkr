import { definePlugin } from '@hydrahost/plugin-sdk';

import { contractFragment } from './contract';
import { NomadConfigSchema } from './schemas';

export const nomadManifest = definePlugin({
  id: 'nomad',
  version: '0.1.0',
  backendModule: () => import('./backend'),
  contract: contractFragment,
  configSchema: NomadConfigSchema,
});

export default nomadManifest;
