import type { TableColumn } from '../../tui/components/table-renderer.js';
import { centsToDollars, formatSizeGB, formatStorageLine } from '../../ui/format.js';
import type { InventoryDetail, InventoryListItem } from './inventory.js';

export const inventoryListColumns: TableColumn<InventoryListItem>[] = [
  { header: 'Name', accessor: (r) => r.name, width: 36 },
  { header: 'Location', accessor: (r) => r.location ?? '—', width: 16 },
  {
    header: 'CPU',
    accessor: (r) => r.cpuModel?.slice(0, 28) ?? '—',
    width: 30,
  },
  {
    header: 'GPU',
    accessor: (r) => {
      if (!r.gpuCount) return '—';
      return `${r.gpuCount}x ${r.gpuModel?.slice(0, 18) ?? ''}`;
    },
    width: 24,
  },
  { header: 'Memory', accessor: (r) => formatSizeGB(r.memoryGb), width: 10 },
  { header: 'Storage', accessor: (r) => formatSizeGB(r.storageGb), width: 10 },
  { header: '$/hr', accessor: (r) => centsToDollars(r.pricePerHourCents), width: 10 },
  { header: 'Status', accessor: (r) => r.stockStatus, width: 12 },
];

export function inventoryDetailFields(d: InventoryDetail): { label: string; value: string }[] {
  return [
    { label: 'Status', value: d.stockStatus },
    { label: 'Location', value: d.location ?? '—' },
    { label: 'Interruptible Only', value: d.isInterruptibleOnly ? 'Yes' : 'No' },
    {
      label: 'Available At',
      value: new Date(d.availableAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    },
  ];
}

export function inventoryPricingFields(d: InventoryDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  if (!d.isInterruptibleOnly) {
    fields.push({ label: 'On-Demand/hr', value: centsToDollars(d.pricing.onDemandPerHourCents) });
    fields.push({ label: 'On-Demand/wk', value: centsToDollars(d.pricing.onDemandPerWeekCents) });
    fields.push({ label: 'On-Demand/mo', value: centsToDollars(d.pricing.onDemandPerMonthCents) });
  }
  if (d.pricing.interruptiblePerHourCents != null) {
    fields.push({ label: 'Interruptible/hr', value: centsToDollars(d.pricing.interruptiblePerHourCents) });
  }
  return fields;
}

export function inventorySpecFields(d: InventoryDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  if (d.cpu.model) fields.push({ label: 'CPU Model', value: d.cpu.model });
  if (d.cpu.count != null) fields.push({ label: 'Physical CPUs', value: String(d.cpu.count) });
  if (d.cpu.totalCores != null) fields.push({ label: 'Total Cores', value: String(d.cpu.totalCores) });
  if (d.cpu.totalThreads != null) fields.push({ label: 'Total Threads', value: String(d.cpu.totalThreads) });
  if (d.gpu.model) {
    fields.push({ label: 'GPU Model', value: d.gpu.model });
    if (d.gpu.count != null) fields.push({ label: 'GPU Count', value: String(d.gpu.count) });
  }
  if (d.memory.totalGb != null) fields.push({ label: 'Memory', value: formatSizeGB(d.memory.totalGb) });
  return fields;
}

export function inventoryStorageFields(d: InventoryDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  const nvme = formatStorageLine(d.storage.nvmeCount, d.storage.nvmeSizeGb, 'NVMe');
  const ssd = formatStorageLine(d.storage.ssdCount, d.storage.ssdSizeGb, 'SSD');
  const hdd = formatStorageLine(d.storage.hddCount, d.storage.hddSizeGb, 'HDD');
  if (nvme) fields.push({ label: 'NVMe', value: nvme });
  if (ssd) fields.push({ label: 'SSD', value: ssd });
  if (hdd) fields.push({ label: 'HDD', value: hdd });
  if (d.storage.totalGb != null) fields.push({ label: 'Total', value: formatSizeGB(d.storage.totalGb) });
  return fields;
}

export function inventoryNetworkingFields(d: InventoryDetail): { label: string; value: string }[] {
  return [
    { label: 'Network Type', value: d.networking.networkType },
    { label: 'VPC Capable', value: d.networking.vpcCapable ? 'Yes' : 'No' },
  ];
}
