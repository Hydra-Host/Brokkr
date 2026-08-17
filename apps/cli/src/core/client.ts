import { contract } from '@repo/api-client/contract';
import type { ApiFetcherArgs } from '@ts-rest/core';
import { initClient, tsRestFetchApi } from '@ts-rest/core';
import { getApiUrl, getConnectionMode, getEnvApiKey, getProcessApiKey, invalidateConfigCache } from '../config/env.js';
import { getSession, invalidateSessionCaches, requireActiveOrg } from '../config/store.js';
import { bridgeApiFetcher } from './bridge-transport.js';

export type CliApiClient = ReturnType<typeof createCliClient>;

export function createCliClient(baseUrl: string, auth: { cookie: string } | { apiKey: string }) {
  const baseHeaders: Record<string, string> = 'apiKey' in auth ? { 'x-api-key': auth.apiKey } : { cookie: auth.cookie };

  return initClient(contract, {
    baseUrl,
    baseHeaders,
    api: async (args: ApiFetcherArgs) => {
      const result = await tsRestFetchApi(args);
      if (result.status === 401) {
        const { fail } = await import('../ui/format.js');
        fail('Session expired or missing organization context. Run: brokkr login');
      }
      return result;
    },
  });
}

export function createBridgeClient() {
  return initClient(contract, {
    baseUrl: '',
    baseHeaders: {},
    api: bridgeApiFetcher,
  });
}

export function getAuthenticatedClient(): CliApiClient {
  if (getConnectionMode() === 'bridge') {
    return createBridgeClient();
  }

  const baseUrl = getApiUrl();

  const processApiKey = getProcessApiKey();
  if (processApiKey) {
    return createCliClient(baseUrl, { apiKey: processApiKey });
  }

  const session = getSession();

  if (session) {
    if (session.apiKey) {
      return createCliClient(baseUrl, { apiKey: session.apiKey });
    }
    requireActiveOrg();
    return createCliClient(baseUrl, { cookie: session.cookie });
  }

  const configApiKey = getEnvApiKey();
  if (configApiKey) {
    return createCliClient(baseUrl, { apiKey: configApiKey });
  }

  throw new Error('Not logged in. Run: brokkr login');
}

export function createMcpClient(baseUrl: string, auth: { cookie: string } | { apiKey: string }) {
  const baseHeaders: Record<string, string> = 'apiKey' in auth ? { 'x-api-key': auth.apiKey } : { cookie: auth.cookie };

  return initClient(contract, {
    baseUrl,
    baseHeaders,
    api: async (args: ApiFetcherArgs) => {
      const result = await tsRestFetchApi(args);
      if (result.status === 401) {
        throw new Error('Unauthorized: session expired or missing organization context');
      }
      return result;
    },
  });
}

export function getAuthenticatedMcpClient(): CliApiClient {
  invalidateConfigCache();
  invalidateSessionCaches();

  const baseUrl = getApiUrl();

  const processApiKey = getProcessApiKey();
  if (processApiKey) {
    return createMcpClient(baseUrl, { apiKey: processApiKey });
  }

  const session = getSession();

  if (session) {
    if (session.apiKey) {
      return createMcpClient(baseUrl, { apiKey: session.apiKey });
    }
    requireActiveOrg();
    return createMcpClient(baseUrl, { cookie: session.cookie });
  }

  const configApiKey = getEnvApiKey();
  if (configApiKey) {
    return createMcpClient(baseUrl, { apiKey: configApiKey });
  }

  throw new Error('Not authenticated. Set BROKKR_API_KEY env var or run: brokkr login');
}
