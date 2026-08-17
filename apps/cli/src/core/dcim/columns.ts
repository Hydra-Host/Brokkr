import type { TableColumn } from '../../tui/components/table-renderer.js';
import { centsToDollars, formatDate, formatSizeGB, formatStorageLine } from '../../ui/format.js';
import type { BridgeDetail, BridgeListItem } from './bridges.js';
import type { DatacenterContact, DatacenterDetail, DatacenterListItem } from './datacenters.js';
import type { ServerDetail, ServerListItem } from './servers.js';

export const datacenterListColumns: TableColumn<DatacenterListItem>[] = [
  { header: 'ID', accessor: (r) => r.id, width: 38 },
  { header: 'Name', accessor: (r) => r.name, width: 24 },
  { header: 'Location', accessor: (r) => [r.city, r.stateOrProvince, r.countryCode].filter(Boolean).join(', ') || '—' },
  { header: 'Timezone', accessor: (r) => r.timezone ?? '—', width: 22 },
  { header: 'Contacts', accessor: (r) => String(r.contactCount), width: 10 },
  { header: 'Created', accessor: (r) => formatDate(r.createdAt), width: 14 },
];

export const contactColumns: TableColumn<DatacenterContact>[] = [
  { header: 'Name', accessor: (r) => r.name },
  { header: 'Email', accessor: (r) => r.email },
  { header: 'Phone', accessor: (r) => r.phone },
  { header: 'Type', accessor: (r) => r.contactType },
];

export const bridgeColumns: TableColumn<{ id: string; name: string }>[] = [
  { header: 'Name', accessor: (r) => r.name },
  { header: 'ID', accessor: (r) => r.id },
];

export function datacenterDetailFields(dc: DatacenterDetail): { label: string; value: string }[] {
  const addr = dc.primaryAddress;
  return [
    { label: 'Timezone', value: addr?.timezone ?? '—' },
    { label: 'Coordinates', value: addr ? `${addr.latitude}, ${addr.longitude}` : '—' },
    { label: 'Primary Address', value: addr?.formattedAddress ?? '—' },
    { label: 'Shipping Address', value: dc.shippingAddress?.formattedAddress ?? '—' },
    { label: 'Created', value: formatDate(dc.createdAt) },
    { label: 'Updated', value: formatDate(dc.updatedAt) },
  ];
}

export const bridgeListColumns: TableColumn<BridgeListItem>[] = [
  { header: 'ID', accessor: (r) => String(r.id), width: 8 },
  { header: 'Name', accessor: (r) => r.name, width: 24 },
  { header: 'Status', accessor: (r) => r.status, width: 12 },
  { header: 'Type', accessor: (r) => r.type, width: 14 },
  { header: 'Data Center', accessor: (r) => r.datacenterName, width: 20 },
  { header: 'Interfaces', accessor: (r) => String(r.interfaceCount), width: 12 },
];

type BridgeInterface = BridgeDetail['interfaces'][number];
export const interfaceColumns: TableColumn<BridgeInterface>[] = [
  { header: 'Name', accessor: (r) => r.name, width: 16 },
  { header: 'MAC', accessor: (r) => r.mac_address, width: 20 },
  { header: 'IPs', accessor: (r) => r.ip_addresses.map((ip) => ip.address).join(', ') || '—', width: 24 },
  { header: 'Enabled', accessor: (r) => (r.enabled ? '✓' : '✗'), width: 9 },
  { header: 'Mgmt', accessor: (r) => (r.mgmt_only ? '✓' : '✗'), width: 6 },
  { header: 'Connected', accessor: (r) => (r.mark_connected ? '✓' : '✗'), width: 11 },
];

export function bridgeDetailFields(b: BridgeDetail): { label: string; value: string }[] {
  return [
    { label: 'Status', value: b.status },
    { label: 'Type', value: b.type },
    { label: 'Data Center', value: b.datacenter.name },
    { label: 'Zone', value: b.zone.name },
  ];
}

function formatPriceCents(cents: number | null): string {
  if (cents == null) return '—';
  return `${centsToDollars(cents)}/hr`;
}

export function deviceDetailFields(d: ServerDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [
    { label: 'Status', value: d.status },
    { label: 'Power', value: d.powerStatus },
    { label: 'Health', value: d.isHealthy === true ? '✓ Healthy' : d.isHealthy === false ? '✗ Unhealthy' : '—' },
    { label: 'Data Center', value: d.datacenter },
    { label: 'Tenant', value: d.tenant },
    { label: 'Eco Mode', value: d.ecoMode ? 'On' : 'Off' },
    { label: 'TEE Capable', value: d.isTeeCapable ? 'Yes' : 'No' },
  ];
  return fields;
}

export function deviceComputeFields(d: ServerDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  if (d.gpu.model) {
    fields.push({ label: 'GPU Model', value: d.gpu.model });
    fields.push({ label: 'GPU Count', value: d.gpu.count != null ? String(d.gpu.count) : '—' });
  }
  if (d.cpu.model) fields.push({ label: 'CPU Model', value: d.cpu.model });
  if (d.cpu.count != null) fields.push({ label: 'Physical CPUs', value: String(d.cpu.count) });
  if (d.cpu.totalCores != null) fields.push({ label: 'Total Cores', value: String(d.cpu.totalCores) });
  if (d.cpu.totalThreads != null) fields.push({ label: 'Total Threads', value: String(d.cpu.totalThreads) });
  if (d.memory.total != null) fields.push({ label: 'Memory', value: formatSizeGB(d.memory.total) });
  return fields;
}

export function deviceStorageFields(d: ServerDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  const nvme = formatStorageLine(d.storage.nvmeCount, d.storage.nvmeSize, 'NVMe');
  const ssd = formatStorageLine(d.storage.ssdCount, d.storage.ssdSize, 'SSD');
  const hdd = formatStorageLine(d.storage.hddCount, d.storage.hddSize, 'HDD');
  if (nvme) fields.push({ label: 'NVMe', value: nvme });
  if (ssd) fields.push({ label: 'SSD', value: ssd });
  if (hdd) fields.push({ label: 'HDD', value: hdd });
  if (d.storage.total != null) fields.push({ label: 'Total', value: formatSizeGB(d.storage.total) });
  return fields;
}

export function deviceNetworkingFields(d: ServerDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  if (d.networking.ipv4) fields.push({ label: 'IPv4', value: d.networking.ipv4 });
  if (d.networking.ipv6) fields.push({ label: 'IPv6', value: d.networking.ipv6 });
  if (d.networking.mac) fields.push({ label: 'MAC', value: d.networking.mac });
  if (d.networking.ipmiIp) fields.push({ label: 'IPMI IP', value: d.networking.ipmiIp });
  if (d.networking.vpcCapable != null) {
    fields.push({ label: 'VPC Capable', value: d.networking.vpcCapable ? 'Yes' : 'No' });
  }
  return fields;
}

export function deviceListingFields(d: ServerDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  if (d.listing.isActive != null) {
    fields.push({ label: 'Listed', value: d.listing.isActive ? 'Yes' : 'No' });
  }
  if (d.listing.isInterruptibleOnly != null) {
    fields.push({ label: 'Interruptible Only', value: d.listing.isInterruptibleOnly ? 'Yes' : 'No' });
  }
  if (d.listing.isPrivate != null) {
    fields.push({ label: 'Private', value: d.listing.isPrivate ? 'Yes' : 'No' });
  }
  fields.push({ label: 'On-Demand Price', value: formatPriceCents(d.listing.onDemandPricePerHourCents) });
  fields.push({ label: 'Interruptible Price', value: formatPriceCents(d.listing.interruptiblePricePerHourCents) });
  return fields;
}

export function deviceDeploymentFields(d: ServerDetail): { label: string; value: string }[] {
  if (!d.deployment) return [{ label: 'Status', value: 'No active deployment' }];
  const fields: { label: string; value: string }[] = [];
  if (d.deployment.deployerEmail) fields.push({ label: 'Deployer', value: d.deployment.deployerEmail });
  if (d.deployment.billingFrequency) fields.push({ label: 'Billing', value: d.deployment.billingFrequency });
  fields.push({ label: 'Price', value: formatPriceCents(d.deployment.pricePerHourCents) });
  return fields;
}

export const deviceListColumns: TableColumn<ServerListItem>[] = [
  { header: 'Name', accessor: (r) => r.name, width: 24 },
  { header: 'ID', accessor: (r) => r.id, width: 38 },
  { header: 'IP', accessor: (r) => r.ipv4 ?? '—', width: 18 },
  {
    header: 'GPU',
    accessor: (r) => {
      if (!r.gpuCount) return '—';
      return `${r.gpuCount}x ${r.gpuModel?.slice(0, 20) ?? ''}`;
    },
    width: 28,
  },
  {
    header: 'Listed',
    accessor: (r) => {
      if (r.isListed === null) return '—';
      if (!r.isListed) return 'No';
      if (r.isInterruptibleOnly) return 'Interruptible';
      return 'Yes';
    },
    width: 14,
  },
  {
    header: '$/hr',
    accessor: (r) => (r.pricePerHourCents != null ? centsToDollars(r.pricePerHourCents) : '—'),
    width: 10,
  },
  { header: 'Health', accessor: (r) => (r.isHealthy === true ? '✓' : r.isHealthy === false ? '✗' : '—'), width: 8 },
  { header: 'Status', accessor: (r) => r.status, width: 12 },
  { header: 'Data Center', accessor: (r) => r.datacenter || '—' },
];
