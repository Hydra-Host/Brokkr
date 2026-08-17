import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';

export interface SshKeyListItem {
  id: string;
  name: string;
  fingerprint: string;
  dateCreated: string;
}

export interface SshKeyDetail {
  id: string;
  name: string;
  fingerprint: string;
  key: string;
  userId: string;
  dateCreated: string;
  dateDeleted: string | null;
}

function mapSshKey(k: {
  id: string;
  name: string;
  fingerprint: string;
  key: string;
  userId: string;
  dateCreated: Date | string;
  dateDeleted: Date | string | null;
}): SshKeyDetail {
  return {
    id: k.id,
    name: k.name,
    fingerprint: k.fingerprint,
    key: k.key,
    userId: k.userId,
    dateCreated: String(k.dateCreated),
    dateDeleted: k.dateDeleted ? String(k.dateDeleted) : null,
  };
}

export async function listSshKeys(
  client: CliApiClient,
  query: { page: number; pageSize: number },
): Promise<{ data: SshKeyListItem[]; meta: PaginationMeta }> {
  const result = await client.getSshKeys({ query });

  if (result.status !== 200) {
    throw new Error(`Failed to list SSH keys (${result.status})`);
  }

  return {
    data: result.body.data.map((k) => ({
      id: k.id,
      name: k.name,
      fingerprint: k.fingerprint,
      dateCreated: String(k.dateCreated),
    })),
    meta: result.body.meta,
  };
}

export async function getSshKey(client: CliApiClient, id: string): Promise<SshKeyDetail> {
  const result = await client.getSshKey({ params: { id } });

  if (result.status === 404) {
    throw new Error(`SSH key not found: ${id}`);
  }

  if (result.status !== 200) {
    throw new Error(`Failed to get SSH key (${result.status})`);
  }

  return mapSshKey(result.body);
}

export async function createSshKey(client: CliApiClient, data: { name: string; key: string }): Promise<SshKeyDetail> {
  const result = await client.createSshKey({ body: data });

  if (result.status !== 201) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to create SSH key (${result.status})`);
  }

  return mapSshKey(result.body);
}

export async function deleteSshKey(client: CliApiClient, id: string): Promise<SshKeyDetail> {
  const result = await client.deleteSshKey({ params: { id } });

  if (result.status === 404) {
    throw new Error(`SSH key not found: ${id}`);
  }

  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to delete SSH key (${result.status})`);
  }

  return mapSshKey(result.body);
}
