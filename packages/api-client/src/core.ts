import { initClient, type ClientArgs } from '@ts-rest/core';
import { contract } from './contract/index';

export type ApiClientOptions = Partial<ClientArgs> & {
  baseUrl: string;
};

export function createApiClient(options: ApiClientOptions) {
  const { baseUrl, ...clientArgs } = options;

  return initClient(contract, {
    baseUrl,
    baseHeaders: {},
    ...clientArgs,
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
