import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { TeeCapability } from '@repo/database';
import { firstValueFrom } from 'rxjs';
import { getErrorMessage } from 'src/common/error-utils';
import {
  NVIDIA_ATTESTATION_TTL_MS,
  NVIDIA_ATTESTATION_URL,
  TEE_CPU_FAMILIES,
  TEE_CPU_MODELS,
  TEE_FIRMWARE,
} from '../../constants/discovery.constants';
import type { CollectorContext, DeviceMutation } from '../collectors/collector.types';
import { ghwBaseboardSchema } from '../collectors/ghw_baseboard/ghw_baseboard.schema';
import { ghwBiosSchema } from '../collectors/ghw_bios/ghw_bios.schema';
import { ghwCpuSchema } from '../collectors/ghw_cpu/ghw_cpu.schema';
import { type GhwGpuInput, ghwGpuSchema } from '../collectors/ghw_gpu/ghw_gpu.schema';
import { kernelParamsSchema } from '../collectors/kernel_params/kernel_params.schema';
import { lscpuSchema } from '../collectors/lscpu/lscpu.schema';
import { nvidiaSchema } from '../collectors/nvidia/nvidia.schema';
import type { Composer } from './composer.types';

const NVIDIA_CARD_PATTERN = /nvidia/i;

// ghw_cpu reports "GenuineIntel" and kernel_params reports "intel"; no other CPUID vendor id
// carries the substring, so one test covers both sources.
const INTEL_CPU_VENDOR_PATTERN = /intel/i;

function hasNvidiaCard(ghwGpu: GhwGpuInput): boolean {
  return ghwGpu.gpu.cards.some((card) =>
    NVIDIA_CARD_PATTERN.test(`${card.pci?.vendor?.name ?? ''} ${card.pci?.product?.name ?? ''}`),
  );
}

// teeCapable: FALSE only when the CPU isn't TEE-capable; TRUE on the full vBIOS attestation chain, or on a GPU-less host (`nvidia` yields no GPU and a parsed `ghw_gpu` lists no NVIDIA card) once CPU, vendor and firmware pass; else PATCH (UNVERIFIED never written here); a CPLD mismatch is deliberately always PATCH.
@Injectable()
export class TeeComposer implements Composer {
  readonly name = 'tee';

  private attestationIds: string[] = [];
  private attestationFetchedAt = 0;

  constructor(private readonly httpService: HttpService) {}

  async compose(ctx: CollectorContext): Promise<DeviceMutation> {
    const lscpu = lscpuSchema.safeParse(ctx.rawBundle.lscpu);
    if (
      !lscpu.success ||
      !TEE_CPU_FAMILIES.includes(lscpu.data.cpu_family ?? '') ||
      !TEE_CPU_MODELS.includes(lscpu.data.cpu_model ?? '')
    ) {
      return { serverUpdate: { teeCapable: TeeCapability.FALSE } };
    }

    const ghwBios = ghwBiosSchema.safeParse(ctx.rawBundle.ghw_bios);
    const ghwBaseboard = ghwBaseboardSchema.safeParse(ctx.rawBundle.ghw_baseboard);
    const kernelParams = kernelParamsSchema.safeParse(ctx.rawBundle.kernel_params);
    const biosVendor = ghwBios.success ? (ghwBios.data.bios.vendor ?? '').toLowerCase() : '';
    // Supermicro boards report AMI as the BIOS vendor, so the baseboard is the typed source that names them.
    const baseboardVendor = ghwBaseboard.success ? (ghwBaseboard.data.baseboard.vendor ?? '').toLowerCase() : '';
    const sysManufacturer = kernelParams.success
      ? String(kernelParams.data.hardware_analysis?.system_manufacturer ?? '').toLowerCase()
      : '';

    const ghwCpu = ghwCpuSchema.safeParse(ctx.rawBundle.ghw_cpu);
    const cpuVendors = ghwCpu.success
      ? ghwCpu.data.cpu.processors.flatMap((processor) => (processor.vendor ? [processor.vendor] : []))
      : [];
    if (cpuVendors.length === 0 && kernelParams.success) {
      const analyzedVendor = String(kernelParams.data.hardware_analysis?.cpu_vendor ?? '');
      if (analyzedVendor) cpuVendors.push(analyzedVendor);
    }
    // TEE_CPU_FAMILIES/TEE_CPU_MODELS are Intel-only CPUID ids; an absent vendor falls through, so
    // this rejects a known-foreign CPU rather than demanding proof of Intel.
    const nonIntelVendor = cpuVendors.find((vendor) => !INTEL_CPU_VENDOR_PATTERN.test(vendor));
    if (nonIntelVendor) {
      return this.notCapable(ctx, `cpu vendor "${nonIntelVendor}" is not intel`);
    }

    const vendorSources = [biosVendor, baseboardVendor, sysManufacturer];
    const teeVendor =
      Object.keys(TEE_FIRMWARE).find((vendor) => vendorSources.some((source) => source.startsWith(vendor))) ?? '';
    if (!teeVendor) {
      return this.patch(
        ctx,
        `no TEE vendor in bios="${biosVendor}" baseboard="${baseboardVendor}" system="${sysManufacturer}"`,
      );
    }

    const vendorFirmware = TEE_FIRMWARE[teeVendor];
    const biosVersion = ghwBios.success ? ghwBios.data.bios.version : undefined;
    if (!biosVersion || !vendorFirmware.bios.includes(biosVersion)) {
      return this.patch(ctx, `${teeVendor} bios "${biosVersion ?? ''}" not in [${vendorFirmware.bios.join(', ')}]`);
    }

    if (vendorFirmware.cpld) {
      const cpld = (ctx.rawBundle as Record<string, unknown>).cpld as { cpld?: { version?: string } } | undefined;
      const cpldVersion = cpld?.cpld?.version ?? '';
      if (!vendorFirmware.cpld.includes(cpldVersion)) {
        return this.patch(ctx, `${teeVendor} cpld "${cpldVersion}" not in [${vendorFirmware.cpld.join(', ')}]`);
      }
    }

    const nvidia = nvidiaSchema.safeParse(ctx.rawBundle.nvidia);
    const nvidiaGpus = nvidia.success && 'gpus' in nvidia.data ? nvidia.data.gpus : [];
    if (nvidiaGpus.length === 0) {
      const ghwGpu = ghwGpuSchema.safeParse(ctx.rawBundle.ghw_gpu);
      if (ghwGpu.success && !hasNvidiaCard(ghwGpu.data)) {
        // CPU-only Intel TDX host: the platform firmware is the whole attestation surface
        return { serverUpdate: { teeCapable: TeeCapability.TRUE } };
      }
      // No vBIOS evidence (bad bundle or CC-mode hiding GPUs): preserve a prior TRUE — hidden GPUs never re-attest, so a downgrade would be permanent.
      const prior = ctx.device.server?.teeCapable;
      if (prior === TeeCapability.TRUE) {
        return { serverUpdate: { teeCapable: TeeCapability.TRUE } };
      }
      const nvidiaState =
        ctx.rawBundle.nvidia === undefined ? 'absent' : nvidia.success ? 'reported no gpus' : 'unparseable';
      const ghwGpuState = ctx.rawBundle.ghw_gpu === undefined ? 'absent' : 'unparseable';
      return this.patch(
        ctx,
        ghwGpu.success
          ? `nvidia card without vbios evidence (nvidia ${nvidiaState}) and prior capability is ${prior ?? 'unset'}`
          : `no gpu evidence (nvidia ${nvidiaState}, ghw_gpu ${ghwGpuState}) and prior capability is ${prior ?? 'unset'}`,
      );
    }

    const vbiosVersions = [...new Set(nvidiaGpus.map((g) => g.vbios ?? ''))];
    if (vbiosVersions.length !== 1 || vbiosVersions[0] === '') {
      return this.patch(ctx, `vbios versions not uniform: [${vbiosVersions.join(', ')}]`);
    }

    await this.refreshAttestation(ctx);
    const attestationStr = this.attestationIds.join(',');
    const vbios = vbiosVersions[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const vbiosPattern = new RegExp(`NV_GPU_VBIOS_[^_\\s]+_[^_\\s]+_[^_\\s]+_${vbios}`, 'i');

    if (!vbiosPattern.test(attestationStr)) {
      return this.patch(ctx, `vbios ${vbiosVersions[0]} not in NVIDIA attestation ids`);
    }
    return { serverUpdate: { teeCapable: TeeCapability.TRUE } };
  }

  private patch(ctx: CollectorContext, reason: string): DeviceMutation {
    ctx.logger.log(`tee: PATCH — ${reason}`);
    return { serverUpdate: { teeCapable: TeeCapability.PATCH } };
  }

  private notCapable(ctx: CollectorContext, reason: string): DeviceMutation {
    ctx.logger.log(`tee: FALSE — ${reason}`);
    return { serverUpdate: { teeCapable: TeeCapability.FALSE } };
  }

  private async refreshAttestation(ctx: CollectorContext): Promise<void> {
    if (Date.now() - this.attestationFetchedAt < NVIDIA_ATTESTATION_TTL_MS) return;
    try {
      const res = await firstValueFrom(this.httpService.get(NVIDIA_ATTESTATION_URL, { timeout: 15000 }));
      this.attestationIds = (res.data as { ids?: string[] }).ids ?? [];
      this.attestationFetchedAt = Date.now();
      ctx.logger.log(`NVIDIA attestation refreshed: ${this.attestationIds.length} IDs`);
    } catch (error) {
      ctx.logger.error(`Failed to fetch NVIDIA attestation: ${getErrorMessage(error)}`);
    }
  }
}
