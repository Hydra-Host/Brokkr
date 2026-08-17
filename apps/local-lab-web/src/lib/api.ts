import { initTsrReactQuery } from '@ts-rest/react-query/v5';

import { contract } from '@/contract';
import { labApiToken } from '@/lib/lab-token';

// The header fn reads the token per-request so Settings changes apply immediately ('' when unset is inert).
export const tsr = initTsrReactQuery(contract, {
  baseUrl: '',
  baseHeaders: { 'x-lab-token': () => labApiToken() },
});
