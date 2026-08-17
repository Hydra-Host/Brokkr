import { initClient } from '@ts-rest/core';
import labContractPkg from './lab-contract.js';

const { contract } = labContractPkg;

type ClientArgs = NonNullable<Parameters<typeof initClient>[1]>;
export type LabApiFetcher = ClientArgs['api'];

export const DEFAULT_LAB_BASE_URL = 'http://127.0.0.1:3002';

export interface LabClientOptions {
  baseUrl?: string;
  token?: string;
  api?: LabApiFetcher;
}

export function resolveLabBaseUrl(explicit?: string): string {
  return explicit || process.env.LAB_MCP_URL || DEFAULT_LAB_BASE_URL;
}

export function resolveLabToken(explicit?: string): string {
  return explicit ?? process.env.LAB_API_TOKEN ?? '';
}

export function createLabClient(options: LabClientOptions = {}) {
  const baseUrl = resolveLabBaseUrl(options.baseUrl);
  const token = resolveLabToken(options.token);
  return initClient(contract, {
    baseUrl,
    baseHeaders: token ? { 'x-lab-token': token } : {},
    ...(options.api ? { api: options.api } : {}),
  });
}

export type LabClient = ReturnType<typeof createLabClient>;

export interface LabContext {
  client: LabClient;
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}

export function createLabContext(options: LabClientOptions & { fetchImpl?: typeof fetch } = {}): LabContext {
  const baseUrl = resolveLabBaseUrl(options.baseUrl);
  const token = resolveLabToken(options.token);
  return {
    client: createLabClient({ ...options, baseUrl, token }),
    baseUrl,
    token,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}
