import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';

export interface DatacenterListItem {
  id: string;
  name: string;
  city: string | null;
  stateOrProvince: string | null;
  countryCode: string | null;
  timezone: string | null;
  contactCount: number;
  createdAt: Date;
}

export interface DatacenterDetail {
  id: string;
  name: string;
  organizationId: string;
  primaryAddress: {
    formattedAddress: string;
    city: string;
    stateOrProvince: string | null;
    countryCode: string;
    timezone: string;
    latitude: number | null;
    longitude: number | null;
  } | null;
  shippingAddress: {
    formattedAddress: string;
  } | null;
  bridges: { id: string; name: string }[];
  createdAt: Date;
  updatedAt: Date;
}

export async function listDatacenters(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string },
): Promise<{ data: DatacenterListItem[]; meta: PaginationMeta }> {
  const result = await client.getZones({ query });

  if (result.status !== 200) {
    throw new Error(`Failed to list data centers (${result.status})`);
  }

  const data = result.body.data.map((zone) => ({
    id: zone.id,
    name: zone.name,
    city: zone.primaryAddress?.city ?? null,
    stateOrProvince: zone.primaryAddress?.stateOrProvince ?? null,
    countryCode: zone.primaryAddress?.countryCode ?? null,
    timezone: zone.primaryAddress?.timezone ?? null,
    contactCount: zone.contactCount,
    createdAt: zone.createdAt,
  }));

  return { data, meta: result.body.meta };
}

export async function getDatacenter(client: CliApiClient, zoneId: string): Promise<DatacenterDetail> {
  const result = await client.getZoneById({ params: { zoneId } });

  if (result.status === 404) {
    throw new Error(`Data center not found: ${zoneId}`);
  }

  if (result.status !== 200) {
    throw new Error(`Failed to get data center (${result.status})`);
  }

  const zone = result.body;
  return {
    id: zone.id,
    name: zone.name,
    organizationId: zone.organizationId,
    primaryAddress: zone.primaryAddress
      ? {
          formattedAddress: zone.primaryAddress.formattedAddress,
          city: zone.primaryAddress.city,
          stateOrProvince: zone.primaryAddress.stateOrProvince,
          countryCode: zone.primaryAddress.countryCode,
          timezone: zone.primaryAddress.timezone,
          latitude: zone.primaryAddress.latitude,
          longitude: zone.primaryAddress.longitude,
        }
      : null,
    shippingAddress: zone.shippingAddress ? { formattedAddress: zone.shippingAddress.formattedAddress } : null,
    bridges: zone.bridges,
    createdAt: zone.createdAt,
    updatedAt: zone.updatedAt,
  };
}

export interface DatacenterContact {
  id: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  contactType: string;
  isShippingContact: boolean;
}

export async function getDatacenterContacts(client: CliApiClient, zoneId: string): Promise<DatacenterContact[]> {
  const result = await client.getZoneContacts({
    params: { zoneId },
    query: { page: 1, pageSize: 100 },
  });

  if (result.status !== 200) {
    return [];
  }

  return result.body.data.map((c) => ({
    id: c.id,
    name: c.name,
    title: c.title,
    email: c.email,
    phone: c.phone,
    contactType: c.contactType,
    isShippingContact: c.isShippingContact,
  }));
}
