import { type ClientArgs } from '@ts-rest/core';
import { initTsrReactQuery } from '@ts-rest/react-query/v5';
import { contract } from './contract/index';
import { createApiClient, type ApiClient, type ApiClientOptions } from './core';

export { createApiClient, type ApiClient, type ApiClientOptions };

export type TsrReactQueryClient = ReturnType<typeof initTsrReactQuery<typeof contract, ClientArgs>>;

export function createTsrReactQueryClient(options: ApiClientOptions): TsrReactQueryClient {
  const { baseUrl, ...clientArgs } = options;

  return initTsrReactQuery(contract, {
    baseUrl,
    baseHeaders: {},
    ...clientArgs,
  });
}
