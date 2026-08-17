import type { TableColumn } from '../../tui/components/table-renderer.js';
import { formatDate, formatSizeGB } from '../../ui/format.js';
import type { DeploymentDetail, DeploymentListItem, DeploymentProject } from './deployments.js';

// base 2 at both steps, matching every other size conversion in the product.
function formatSizeBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1).replace(/\.0$/, '')} TB`;
  return `${Math.round(gb)} GB`;
}

function formatStorageLine(count: number, sizeBytes: number, type: string): string | null {
  if (!count || !sizeBytes) return null;
  return `${count}x ${formatSizeBytes(sizeBytes)} ${type}`;
}

export const deploymentListColumns: TableColumn<DeploymentListItem>[] = [
  { header: 'Project', accessor: (r) => r.project },
  { header: 'Name', accessor: (r) => r.name },
  { header: 'ID', accessor: (r) => r.id },
  { header: 'Status', accessor: (r) => r.status },
  { header: 'Power', accessor: (r) => r.powerStatus },
  { header: 'IPv4', accessor: (r) => r.ipv4 ?? '—' },
];

export const projectListColumns: TableColumn<DeploymentProject>[] = [
  { header: 'ID', accessor: (r) => r.id, width: 36 },
  { header: 'Name', accessor: (r) => r.name },
  { header: 'Default', accessor: (r) => (r.isDefault ? '✓' : '✗'), width: 8 },
  { header: 'Deployments', accessor: (r) => String(r.deploymentCount), width: 12 },
];

export function deploymentDetailFields(d: DeploymentDetail): { label: string; value: string }[] {
  return [
    { label: 'Status', value: d.status },
    { label: 'Power', value: d.powerStatus },
    { label: 'Location', value: d.location },
    { label: 'Locked', value: d.isLocked ? 'Yes' : 'No' },
    { label: 'Project', value: d.project ? `${d.project.name}${d.project.isDefault ? ' (default)' : ''}` : '—' },
    { label: 'Provisioned', value: formatDate(d.provisionedDate) },
    ...(d.rescueOs ? [{ label: 'Rescue OS', value: d.rescueOs }] : []),
  ];
}

export function deploymentComputeFields(d: DeploymentDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  if (d.specs.os) fields.push({ label: 'OS', value: d.specs.os });
  if (d.specs.gpu.model) {
    fields.push({ label: 'GPU Model', value: d.specs.gpu.model });
    fields.push({ label: 'GPU Count', value: String(d.specs.gpu.count) });
  }
  if (d.specs.cpu.model) fields.push({ label: 'CPU Model', value: d.specs.cpu.model });
  if (d.specs.cpu.count) fields.push({ label: 'Physical CPUs', value: String(d.specs.cpu.count) });
  if (d.specs.cpu.totalCores) fields.push({ label: 'Total Cores', value: String(d.specs.cpu.totalCores) });
  if (d.specs.cpu.totalThreads) fields.push({ label: 'Total Threads', value: String(d.specs.cpu.totalThreads) });
  if (d.specs.memory.total) fields.push({ label: 'Memory', value: formatSizeGB(d.specs.memory.total) });
  return fields;
}

export function deploymentStorageFields(d: DeploymentDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  const nvme = formatStorageLine(d.specs.storage.nvmeCount, d.specs.storage.nvmeSize, 'NVMe');
  const ssd = formatStorageLine(d.specs.storage.ssdCount, d.specs.storage.ssdSize, 'SSD');
  const hdd = formatStorageLine(d.specs.storage.hddCount, d.specs.storage.hddSize, 'HDD');
  if (nvme) fields.push({ label: 'NVMe', value: nvme });
  if (ssd) fields.push({ label: 'SSD', value: ssd });
  if (hdd) fields.push({ label: 'HDD', value: hdd });
  if (d.specs.storage.total) fields.push({ label: 'Total', value: formatSizeBytes(d.specs.storage.total) });
  return fields;
}

export function deploymentNetworkingFields(d: DeploymentDetail): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  if (d.networking.ipv4) fields.push({ label: 'IPv4', value: d.networking.ipv4 });
  if (d.networking.ipv6) fields.push({ label: 'IPv6', value: d.networking.ipv6 });
  if (d.networking.mac) fields.push({ label: 'MAC', value: d.networking.mac });
  if (d.networking.sshCommand) fields.push({ label: 'SSH Command', value: d.networking.sshCommand });
  return fields;
}

export function deploymentSshKeyFields(d: DeploymentDetail): { label: string; value: string }[] {
  if (d.sshKeys.length === 0) return [];
  return d.sshKeys.map((k) => ({
    label: k.name,
    value: k.user,
  }));
}

type LifecycleAction = DeploymentDetail['lifecycleActions'][number];

export const lifecycleActionColumns: TableColumn<LifecycleAction>[] = [
  { header: 'Action', accessor: (r) => r.actionType, width: 18 },
  { header: 'By', accessor: (r) => r.performedByName, width: 24 },
  { header: 'Source', accessor: (r) => r.source, width: 10 },
  { header: 'Date', accessor: (r) => formatDate(r.performedAt), width: 14 },
];
