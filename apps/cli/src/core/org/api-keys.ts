import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';

export interface ApiKeyListItem {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  role: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  requestCount: number;
  remaining: number | null;
  lastRequest: string | null;
  createdByName: string | null;
  createdByEmail: string;
}

function mapApiKey(k: {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  role: string;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  requestCount: number;
  remaining: number | null;
  lastRequest: Date | null;
  createdByName: string | null;
  createdByEmail: string;
}): ApiKeyListItem {
  return {
    id: k.id,
    name: k.name,
    start: k.start,
    prefix: k.prefix,
    role: k.role,
    enabled: k.enabled,
    expiresAt: k.expiresAt ? String(k.expiresAt) : null,
    createdAt: String(k.createdAt),
    requestCount: k.requestCount,
    remaining: k.remaining,
    lastRequest: k.lastRequest ? String(k.lastRequest) : null,
    createdByName: k.createdByName,
    createdByEmail: k.createdByEmail,
  };
}

export async function listApiKeys(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string; createdByEmail?: string },
): Promise<{ data: ApiKeyListItem[]; meta: PaginationMeta }> {
  const result = await client.listApiKeys({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.createdByEmail ? { createdByEmail: query.createdByEmail } : {}),
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to list API keys (${result.status})`);
  }

  return { data: result.body.data.map(mapApiKey), meta: result.body.meta };
}

export async function getApiKey(client: CliApiClient, apiKeyId: string): Promise<ApiKeyListItem> {
  const result = await client.getApiKey({ params: { apiKeyId } });

  if (result.status === 404) {
    throw new Error(`API key not found: ${apiKeyId}`);
  }

  if (result.status !== 200) {
    throw new Error(`Failed to get API key (${result.status})`);
  }

  return mapApiKey(result.body);
}

export interface CreatedApiKeyResult extends ApiKeyListItem {
  key: string;
}

export async function createApiKey(
  client: CliApiClient,
  data: { name: string; expiresInMilliseconds?: number },
): Promise<CreatedApiKeyResult> {
  const result = await client.createApiKey({
    body: {
      name: data.name,
      ...(data.expiresInMilliseconds ? { expiresIn: data.expiresInMilliseconds } : {}),
    },
  });

  if (result.status !== 201) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to create API key (${result.status})`);
  }

  return {
    ...mapApiKey(result.body),
    key: result.body.key,
  };
}

export async function deleteApiKey(client: CliApiClient, apiKeyId: string): Promise<{ success: boolean }> {
  const result = await client.deleteApiKey({
    params: { apiKeyId },
  });

  if (result.status === 404) {
    throw new Error(`API key not found: ${apiKeyId}`);
  }

  if (result.status !== 204) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to delete API key (${result.status})`);
  }

  return { success: true };
}
