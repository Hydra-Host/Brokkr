import type { CliApiClient } from '../client.js';

export interface OrgSettings {
  id: string;
  name: string;
  tenantType: string;
  logo: string | null;
  email: string | null;
  country: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export async function getOrgSettings(client: CliApiClient): Promise<OrgSettings> {
  const result = await client.getOrganization();

  if (result.status !== 200) {
    throw new Error(`Failed to get organization settings (${result.status})`);
  }

  const o = result.body;
  return {
    id: o.id,
    name: o.name,
    tenantType: o.tenantType,
    logo: o.logo,
    email: o.email ?? null,
    country: o.country ?? null,
    createdAt: String(o.createdAt),
    updatedAt: o.updatedAt ? String(o.updatedAt) : null,
  };
}

export async function updateOrgSettings(
  client: CliApiClient,
  data: { name?: string; email?: string | null; country?: string | null },
): Promise<OrgSettings> {
  const result = await client.updateOrganization({
    body: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.country !== undefined ? { country: data.country } : {}),
    },
  });

  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to update organization settings (${result.status})`);
  }

  const o = result.body;
  return {
    id: o.id,
    name: o.name,
    tenantType: o.tenantType,
    logo: o.logo,
    email: o.email ?? null,
    country: o.country ?? null,
    createdAt: String(o.createdAt),
    updatedAt: o.updatedAt ? String(o.updatedAt) : null,
  };
}
