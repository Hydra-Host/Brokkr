import type { BaseLayer, CustomizationLayer } from '@repo/api-client';
import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';
import { coerceDefaultDiskLayouts, type DiskFormat } from './schemas.js';

export interface DiskLayout {
  config: string;
  format: DiskFormat;
  mountpoint: string;
  diskType: string;
  disks: string[];
  encrypt?: boolean;
  // Deliberately required, never defaulted: reprovision passes false to preserve data; a silent default would wipe it.
  wipe: boolean;
}

export interface DeploymentListItem {
  id: string;
  name: string;
  project: string;
  status: string;
  powerStatus: string;
  location: string;
  gpu: string;
  os: string | null;
  ipv4: string | null;
  sshCommand: string | null;
  isLocked: boolean;
  provisionedDate: string;
}

export interface DeploymentDetail {
  id: string;
  name: string;
  status: string;
  powerStatus: string;
  location: string;
  isLocked: boolean;
  project: { id: string; name: string; isDefault: boolean } | null;
  provisionedDate: string;
  rescueOs: string | null;
  specs: {
    os: string | null;
    gpu: { model: string; count: number };
    cpu: {
      model: string;
      count: number;
      totalCores: number;
      totalThreads: number;
    };
    memory: { total: number };
    storage: {
      nvmeCount: number;
      nvmeSize: number;
      ssdCount: number;
      ssdSize: number;
      hddCount: number;
      hddSize: number;
      total: number;
    };
  };
  networking: {
    ipv4: string | null;
    ipv6: string | null;
    mac: string | null;
    sshCommand: string | null;
  };
  sshKeys: { name: string; user: string }[];
  lifecycleActions: {
    actionType: string;
    performedByName: string;
    performedAt: string;
    source: string;
  }[];
  availableBaseLayers: BaseLayer[];
  availableComponentLayersByBase: Record<string, CustomizationLayer[]>;
  defaultDiskLayouts: DiskLayout[];
}

export function inferSshUser(os: string | null, rescueOs: string | null): string {
  if (rescueOs) return 'root';
  const lower = (os ?? '').toLowerCase();
  if (lower.includes('ubuntu')) return 'ubuntu';
  if (lower.includes('debian')) return 'debian';
  return 'root';
}

export function formatGpu(gpu: { model: string; count: number }): string {
  if (!gpu.count) return '—';
  return `${gpu.count}x ${gpu.model?.slice(0, 20) ?? ''}`;
}

export function mapDeploymentListItem(d: {
  id: string;
  customer: { deviceName: string; provisionedDate: string };
  project?: { name: string } | null;
  status: { label: string };
  powerStatus: { label: string };
  location: string;
  specs: { gpu: { model: string; count: number }; operating_system?: string | null };
  networking?: { ipv4?: string | null } | null;
  isLocked: boolean;
}): DeploymentListItem {
  return {
    id: d.id,
    name: d.customer.deviceName,
    project: d.project?.name ?? '—',
    status: d.status.label,
    powerStatus: d.powerStatus.label,
    location: d.location,
    gpu: formatGpu(d.specs.gpu),
    os: d.specs.operating_system ?? null,
    ipv4: d.networking?.ipv4 ?? null,
    sshCommand: d.networking?.ipv4
      ? `ssh ${inferSshUser(d.specs.operating_system ?? null, null)}@${d.networking.ipv4}`
      : null,
    isLocked: d.isLocked,
    provisionedDate: d.customer.provisionedDate,
  };
}

export async function listDeployments(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string; project?: string },
): Promise<{ data: DeploymentListItem[]; meta: PaginationMeta }> {
  const result = await client.getDeployments({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.search ? { search: query.search } : {}),
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to list deployments (${result.status})`);
  }

  let data = result.body.data.map(mapDeploymentListItem);

  if (query.project) {
    const filter = query.project.toLowerCase();
    data = data.filter((d) => d.project.toLowerCase().includes(filter));
  }

  if (!query.sort) {
    data.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  }

  const meta = query.project
    ? { page: 1, pageSize: data.length || 20, totalItems: data.length, totalPages: 1 }
    : result.body.meta;

  return { data, meta };
}

export interface DeploymentProject {
  id: string;
  name: string;
  isDefault: boolean;
  deploymentCount: number;
}

export async function listDeploymentProjects(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string },
): Promise<{ data: DeploymentProject[]; meta: PaginationMeta }> {
  const result = await client.getDeploymentProjects({ query });
  if (result.status !== 200) throw new Error(`Failed to list projects (${result.status})`);
  return {
    data: result.body.data.map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: p.isDefault,
      deploymentCount: p.deployments.length,
    })),
    meta: result.body.meta,
  };
}

export async function getProjectDeployments(client: CliApiClient, projectId: string): Promise<DeploymentListItem[]> {
  const result = await client.getDeploymentProjectById({ params: { projectId } });
  if (result.status === 404) throw new Error('Project not found');
  if (result.status !== 200) throw new Error(`Failed to get project (${result.status})`);
  return result.body.deployments.map(mapDeploymentListItem);
}

export async function getDeployment(client: CliApiClient, id: string): Promise<DeploymentDetail> {
  const result = await client.getDeploymentById({ params: { id } });

  if (result.status === 404) {
    throw new Error(`Deployment not found: ${id}`);
  }

  if (result.status !== 200) {
    throw new Error(`Failed to get deployment (${result.status})`);
  }

  const d = result.body;
  return {
    id: d.id,
    name: d.customer.deviceName,
    status: d.status.label,
    powerStatus: d.powerStatus.label,
    location: d.location,
    isLocked: d.isLocked,
    project: d.project ? { id: d.project.id, name: d.project.name, isDefault: d.project.isDefault } : null,
    provisionedDate: d.customer.provisionedDate,
    rescueOs: d.specs.current_rescue_operating_system_name ?? null,
    specs: {
      os: d.specs.operating_system ?? null,
      gpu: d.specs.gpu,
      cpu: d.specs.cpu,
      memory: d.specs.memory,
      storage: d.specs.storage,
    },
    networking: {
      ipv4: d.networking?.ipv4 ?? null,
      ipv6: d.networking?.ipv6 ?? null,
      mac: d.networking?.mac ?? null,
      sshCommand: d.networking?.ipv4
        ? `ssh ${inferSshUser(d.specs.operating_system ?? null, d.specs.current_rescue_operating_system_name ?? null)}@${d.networking.ipv4}`
        : null,
    },
    sshKeys: d.sshKeys.map((k) => ({
      name: k.name,
      user: [k.user?.firstName, k.user?.lastName].filter(Boolean).join(' ') || '—',
    })),
    lifecycleActions: d.lifecycleActions.map((a) => ({
      actionType: a.actionType,
      performedByName: a.performedByName,
      performedAt: a.performedAt,
      source: a.source,
    })),
    availableBaseLayers: d.availableBaseLayers ?? [],
    availableComponentLayersByBase: d.availableComponentLayersByBase ?? {},
    defaultDiskLayouts: coerceDefaultDiskLayouts(d.defaultDiskLayouts),
  };
}
