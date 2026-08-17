import { readFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('collection');

const CONSOLE_PREFIXES = ['console=', 'earlycon=', 'earlyprintk='];
const DISPLAY_PARAMS = ['nomodeset', 'vga=', 'video=', 'i915.', 'nouveau.', 'radeon.', 'amdgpu.'];
const SECURITY_PARAMS = ['intel_iommu=', 'iommu=', 'efi=', 'lockdown=', 'apparmor=', 'selinux='];
const NETWORK_PARAMS = ['net.ifnames=', 'biosdevname=', 'ip=', 'nameserver=', 'ifname=', 'bond=', 'vlan='];
const STORAGE_PARAMS = ['root=', 'rootfstype=', 'rootflags=', 'rootdelay=', 'resume=', 'dm-mod.', 'md.'];
const POWER_PARAMS = ['intel_pstate=', 'processor.max_cstate=', 'idle=', 'acpi=', 'noapic'];
const HARDWARE_PARAMS = ['mem=', 'memmap=', 'hugepages=', 'hugepagesz=', 'default_hugepagesz=', 'pci=', 'tsc='];

type Categories = {
  console: string[];
  display: string[];
  security: string[];
  network: string[];
  storage: string[];
  power: string[];
  hardware: string[];
  other: string[];
};

function startsOrEquals(param: string, needles: readonly string[]): boolean {
  return needles.some((p) => param.startsWith(p) || param === p);
}

function categorizeParams(cmdline: string): Categories {
  const categories: Categories = {
    console: [],
    display: [],
    security: [],
    network: [],
    storage: [],
    power: [],
    hardware: [],
    other: [],
  };

  for (const param of cmdline.split(/\s+/).filter(Boolean)) {
    if (CONSOLE_PREFIXES.some((p) => param.startsWith(p))) {
      categories.console.push(param);
    } else if (startsOrEquals(param, DISPLAY_PARAMS)) {
      categories.display.push(param);
    } else if (SECURITY_PARAMS.some((p) => param.startsWith(p))) {
      categories.security.push(param);
    } else if (NETWORK_PARAMS.some((p) => param.startsWith(p))) {
      categories.network.push(param);
    } else if (STORAGE_PARAMS.some((p) => param.startsWith(p))) {
      categories.storage.push(param);
    } else if (startsOrEquals(param, POWER_PARAMS)) {
      categories.power.push(param);
    } else if (HARDWARE_PARAMS.some((p) => param.startsWith(p))) {
      categories.hardware.push(param);
    } else {
      categories.other.push(param);
    }
  }

  return categories;
}

async function readOsRelease(): Promise<Record<string, string>> {
  try {
    const content = await readFile('/etc/os-release', 'utf8');
    const info: Record<string, string> = {};
    for (const line of content.trim().split('\n')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const value = line
        .slice(eqIdx + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1');
      info[key] = value;
    }
    return info;
  } catch {
    return {};
  }
}

function stripQuotes(v: string): string {
  return v.trim().replace(/^"(.*)"$/, '$1');
}

async function readGrubConfig(): Promise<{
  cmdline_linux?: string;
  terminal?: string;
  serial_command?: string;
}> {
  const config: { cmdline_linux?: string; terminal?: string; serial_command?: string } = {};
  try {
    const content = await readFile('/etc/default/grub', 'utf8');
    for (const raw of content.trim().split('\n')) {
      const line = raw.trim();
      if (line.startsWith('GRUB_CMDLINE_LINUX=')) {
        config.cmdline_linux = stripQuotes(line.slice('GRUB_CMDLINE_LINUX='.length));
      } else if (line.startsWith('GRUB_TERMINAL=')) {
        config.terminal = stripQuotes(line.slice('GRUB_TERMINAL='.length));
      } else if (line.startsWith('GRUB_SERIAL_COMMAND=')) {
        config.serial_command = stripQuotes(line.slice('GRUB_SERIAL_COMMAND='.length));
      }
    }
  } catch (error) {
    logger.debug('grub config read failed', { path: '/etc/default/grub', error: String(error) });
  }
  return config;
}

interface HardwareAnalysis {
  gpu_type: 'nvidia' | 'amd' | 'none' | 'unknown';
  gpu_compatibility?: 'configured' | 'needs_nomodeset';
  cpu_vendor: 'intel' | 'amd' | 'unknown';
  vtd_support: boolean;
  iommu_status: 'enabled' | 'disabled_but_supported' | 'not_supported' | 'unknown';
  system_manufacturer: string;
}

async function analyzeHardware(parsed: Categories): Promise<HardwareAnalysis> {
  const analysis: HardwareAnalysis = {
    gpu_type: 'unknown',
    cpu_vendor: 'unknown',
    vtd_support: false,
    iommu_status: 'unknown',
    system_manufacturer: 'unknown',
  };

  try {
    const lspci = await run('lspci', ['-nn'], { timeout_ms: 10_000 });
    const upper = lspci.stdout.toUpperCase();
    if (upper.includes('NVIDIA')) {
      analysis.gpu_type = 'nvidia';
      const hasNomodeset = parsed.display.some((p) => p.includes('nomodeset'));
      analysis.gpu_compatibility = hasNomodeset ? 'configured' : 'needs_nomodeset';
    } else if (upper.includes('AMD') || upper.includes('ATI')) {
      analysis.gpu_type = 'amd';
    } else {
      analysis.gpu_type = 'none';
    }
  } catch {
    analysis.gpu_type = 'unknown';
  }

  try {
    const cpuinfo = await readFile('/proc/cpuinfo', 'utf8');
    if (cpuinfo.includes('GenuineIntel')) analysis.cpu_vendor = 'intel';
    else if (cpuinfo.includes('AuthenticAMD')) analysis.cpu_vendor = 'amd';
    else analysis.cpu_vendor = 'unknown';
  } catch {
    analysis.cpu_vendor = 'unknown';
  }

  try {
    const dmesg = await run('dmesg', [], { timeout_ms: 10_000 });
    const out = dmesg.stdout;
    analysis.vtd_support = out.includes('DMAR') || out.includes('AMD-Vi');
    const hasIommu = parsed.security.some((p) => p.includes('iommu=on') || p.includes('intel_iommu=on'));
    if (hasIommu) analysis.iommu_status = 'enabled';
    else if (analysis.vtd_support) analysis.iommu_status = 'disabled_but_supported';
    else analysis.iommu_status = 'not_supported';
  } catch {
    analysis.vtd_support = false;
    analysis.iommu_status = 'unknown';
  }

  try {
    const mfg = await run('dmidecode', ['-s', 'system-manufacturer'], { timeout_ms: 10_000 });
    analysis.system_manufacturer = mfg.stdout.trim().toLowerCase() || 'unknown';
  } catch {
    analysis.system_manufacturer = 'unknown';
  }

  return analysis;
}

function detectIssues(analysis: HardwareAnalysis): { severity: string; message: string }[] {
  const issues: { severity: string; message: string }[] = [];

  if (analysis.gpu_type === 'nvidia' && analysis.gpu_compatibility === 'needs_nomodeset') {
    issues.push({
      severity: 'warning',
      message: 'NVIDIA GPU detected without nomodeset kernel parameter',
    });
  }

  if (analysis.iommu_status === 'disabled_but_supported') {
    issues.push({
      severity: 'info',
      message: 'IOMMU/VT-d supported but not enabled in kernel params',
    });
  }

  return issues;
}

function buildRecommendations(analysis: HardwareAnalysis): { action: string; parameter: string; reason: string }[] {
  const recommendations: { action: string; parameter: string; reason: string }[] = [];

  if (analysis.gpu_compatibility === 'needs_nomodeset') {
    recommendations.push({
      action: 'add',
      parameter: 'nomodeset',
      reason: 'Required for NVIDIA GPU compatibility',
    });
  }

  if (analysis.iommu_status === 'disabled_but_supported') {
    if (analysis.cpu_vendor === 'intel') {
      recommendations.push({
        action: 'add',
        parameter: 'intel_iommu=on',
        reason: 'Enable VT-d for SR-IOV/VFIO',
      });
    } else if (analysis.cpu_vendor === 'amd') {
      recommendations.push({
        action: 'add',
        parameter: 'amd_iommu=on',
        reason: 'Enable AMD-Vi for SR-IOV/VFIO',
      });
    }
  }

  return recommendations;
}

export function registerKernelParamsCollector(): void {
  registerOperation('collection.kernel_params', async () => {
    const cmdline = (await readFile('/proc/cmdline', 'utf8')).trim();
    const parsed = categorizeParams(cmdline);
    const osInfo = await readOsRelease();
    const grub_config = await readGrubConfig();
    const hardware_analysis = await analyzeHardware(parsed);
    const issues_detected = detectIssues(hardware_analysis);
    const recommendations = buildRecommendations(hardware_analysis);

    return {
      kernel_params: {
        current_cmdline: cmdline,
        parsed_parameters: parsed,
        ubuntu_version: osInfo.PRETTY_NAME ?? null,
        grub_config,
        hardware_analysis,
        issues_detected,
        recommendations,
      },
    };
  });
}
