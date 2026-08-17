import { API_PREFIX } from '@hydrahost/plugin-sdk';
import { initContract } from '@ts-rest/core';

import { GreetingsListResponseSchema } from './schemas';

const c = initContract();

export const contractFragment = c.router(
  {
    helloWorldListGreetings: {
      method: 'GET',
      path: '/plugins/hello-world/greetings',
      responses: { 200: GreetingsListResponseSchema },
      summary: 'List hello-world greetings',
      description:
        'Returns every row from the plugin_hello_world.greetings table — the rows the plugin migration seeded plus anything added later.',
      metadata: { visibility: 'public' as const },
    },
  },
  { pathPrefix: API_PREFIX },
);
