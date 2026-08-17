import { OperatingSystemSlugSchema } from '@repo/api-client';
import type { CliApiClient } from '../client.js';
import type { DiskLayout } from './deployments.js';

export interface DeploymentActionResult {
  success: boolean;
  errorCode?: string | null;
  message?: string | null;
}

export interface SshKeyOption {
  id: string;
  name: string;
  fingerprint: string;
  userName: string;
}

function mapActionResult(body: {
  success: boolean;
  error_code?: string | null;
  message?: string | null;
}): DeploymentActionResult {
  return { success: body.success, errorCode: body.error_code, message: body.message };
}

export async function renameDeployment(client: CliApiClient, id: string, name: string): Promise<{ name: string }> {
  const result = await client.updateDeploymentNickname({ params: { id }, body: { name } });
  if (result.status !== 200) {
    throw new Error(`Failed to rename deployment (${result.status})`);
  }
  return { name: result.body.customer.deviceName };
}

export async function powerControlDeployment(
  client: CliApiClient,
  id: string,
  operation: 'on' | 'off',
): Promise<DeploymentActionResult> {
  const result = await client.powerControlDeployment({ params: { id }, body: { operation } });
  if (result.status !== 200) {
    throw new Error(`Failed to power ${operation} deployment (${result.status})`);
  }
  return mapActionResult(result.body);
}

export async function powerCycleDeployment(client: CliApiClient, id: string): Promise<DeploymentActionResult> {
  const result = await client.powerCycleDeployment({ params: { id }, body: {} });
  if (result.status !== 200) {
    throw new Error(`Failed to power cycle deployment (${result.status})`);
  }
  return mapActionResult(result.body);
}

export async function activateRescueMode(client: CliApiClient, id: string): Promise<DeploymentActionResult> {
  const result = await client.activateRescueMode({ params: { id }, body: {} });
  if (result.status !== 200) {
    throw new Error(`Failed to activate rescue mode (${result.status})`);
  }
  return mapActionResult(result.body);
}

export async function deactivateRescueMode(client: CliApiClient, id: string): Promise<DeploymentActionResult> {
  const result = await client.deactivateRescueMode({ params: { id }, body: {} });
  if (result.status !== 200) {
    throw new Error(`Failed to deactivate rescue mode (${result.status})`);
  }
  return mapActionResult(result.body);
}

export async function toggleDeploymentLock(client: CliApiClient, id: string): Promise<DeploymentActionResult> {
  const result = await client.toggleDeploymentLock({ params: { id }, body: {} });
  if (result.status !== 200) {
    throw new Error(`Failed to toggle deployment lock (${result.status})`);
  }
  return mapActionResult(result.body);
}

export async function deprovisionDeployment(client: CliApiClient, id: string): Promise<DeploymentActionResult> {
  const result = await client.deprovisionDeployment({ params: { id } });
  if (result.status !== 200) {
    throw new Error(`Failed to deprovision deployment (${result.status})`);
  }
  return mapActionResult(result.body);
}

export async function reprovisionDeployment(
  client: CliApiClient,
  id: string,
  body: {
    deploymentName: string;
    operatingSystem: string;
    sshKeyIds: string[];
    diskLayouts: DiskLayout[];
    cloudInit?: string | Record<string, unknown> | null;
    ipxeUrl?: string;
    customizations?: Record<string, string | string[]> | null;
  },
): Promise<DeploymentActionResult> {
  const result = await client.reprovisionDeployment({
    params: { id },
    body: {
      ...body,
      operatingSystem: OperatingSystemSlugSchema.parse(body.operatingSystem),
      cloudInit: body.cloudInit ?? null,
      ipxeUrl: body.ipxeUrl ?? null,
      customizations: body.customizations ?? null,
    },
  });
  if (result.status !== 200) {
    throw new Error(`Failed to reprovision deployment (${result.status})`);
  }
  return mapActionResult(result.body);
}

export async function createDeploymentProject(
  client: CliApiClient,
  name: string,
): Promise<{ id: string; name: string }> {
  const result = await client.createDeploymentProject({ body: { name } });
  if (result.status !== 201) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to create project (${result.status})`);
  }
  return { id: result.body.id, name: result.body.name };
}

export async function deleteDeploymentProject(
  client: CliApiClient,
  projectId: string,
): Promise<{ id: string; name: string }> {
  const result = await client.deleteDeploymentProject({ params: { projectId } });
  if (result.status === 404) throw new Error(`Project not found: ${projectId}`);
  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to delete project (${result.status})`);
  }
  return { id: result.body.id, name: result.body.name };
}

export async function listOrganizationSshKeys(client: CliApiClient): Promise<SshKeyOption[]> {
  const pageSize = 100;
  const result = await client.getOrganizationSshKeys({ query: { page: 1, pageSize } });
  if (result.status !== 200) {
    throw new Error(`Failed to list SSH keys (${result.status})`);
  }
  if (result.body.meta.totalItems > pageSize) {
    const { warn } = await import('../../ui/format.js');
    warn(`Showing first ${pageSize} of ${result.body.meta.totalItems} SSH keys`);
  }
  return result.body.data.map((k) => ({
    id: k.id,
    name: k.name,
    fingerprint: k.fingerprint,
    userName: [k.user?.firstName, k.user?.lastName].filter(Boolean).join(' ') || '—',
  }));
}
