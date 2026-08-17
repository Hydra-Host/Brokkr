import { z } from 'zod';
import { authedFetch, authedFetchWithBody } from './fetch.js';

export interface OrgListItem {
  id: string;
  name: string;
  tenantType: string;
  role: string;
}

const OrgListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tenantType: z.string().optional(),
      role: z.string().optional(),
    }),
  ),
  meta: z
    .object({
      page: z.number(),
      totalPages: z.number(),
    })
    .optional(),
});

const MAX_PAGES = 100;

export async function listOrganizations(): Promise<OrgListItem[]> {
  const all: OrgListItem[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await authedFetch(`/api/v1/organizations?page=${page}&pageSize=100`);
    if (!response.ok) {
      throw new Error(`Failed to list organizations (${response.status})`);
    }

    const body = OrgListResponseSchema.parse(await response.json());

    for (const org of body.data) {
      all.push({
        id: org.id,
        name: org.name,
        tenantType: org.tenantType ?? 'Unknown',
        role: org.role ?? 'Member',
      });
    }

    if (!body.meta || page >= body.meta.totalPages || body.data.length === 0) break;
  }

  return all;
}

export async function setActiveOrganization(orgId: string): Promise<void> {
  const response = await authedFetchWithBody(`/api/v1/organizations/${orgId}/set-active`, 'POST', {});

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to set active organization (${response.status}): ${text}`);
  }
}
