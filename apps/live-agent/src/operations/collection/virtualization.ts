import { readFile, readdir } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { CommandAborted, run } from '../../exec';

async function detectHypervisorExtensions(): Promise<boolean | null> {
  try {
    const cpuinfo = await readFile('/proc/cpuinfo', 'utf8');
    return /\b(vmx|svm)\b/.test(cpuinfo);
  } catch {
    return null;
  }
}

async function detectIommuGroups(): Promise<boolean | null> {
  try {
    const entries = await readdir('/sys/kernel/iommu_groups/');
    return entries.length > 0;
  } catch {
    return null;
  }
}

async function detectSriovInDmesg(): Promise<boolean | null> {
  try {
    const { stdout, exit_code } = await run('dmesg', [], { timeout_ms: 15_000 });
    if (exit_code !== 0) return null;
    return /SR-IOV enabled|Initializing SR-IOV/i.test(stdout);
  } catch (error) {
    if (error instanceof CommandAborted) throw error;
    return null;
  }
}

type VirtualizationFacts = {
  hypervisor_enabled: boolean | null;
  iommu_groups_enabled: boolean | null;
  sriov_bios_enabled: boolean | null;
};

export async function collectVirtualization(): Promise<{ virtualization: VirtualizationFacts }> {
  const [hypervisor_enabled, iommu_groups_enabled, sriov_bios_enabled] = await Promise.all([
    detectHypervisorExtensions(),
    detectIommuGroups(),
    detectSriovInDmesg(),
  ]);

  if (hypervisor_enabled === null && iommu_groups_enabled === null && sriov_bios_enabled === null) {
    throw new Error('virtualization detection failed: cpuinfo, iommu groups, and dmesg all unavailable');
  }

  return { virtualization: { hypervisor_enabled, iommu_groups_enabled, sriov_bios_enabled } };
}

export function registerVirtualizationCollector(): void {
  registerOperation('collection.virtualization', collectVirtualization);
}
