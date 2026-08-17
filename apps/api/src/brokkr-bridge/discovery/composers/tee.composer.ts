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
import { ghwBiosSchema } from '../collectors/ghw_bios/ghw_bios.schema';
import { kernelParamsSchema } from '../collectors/kernel_params/kernel_params.schema';
import { lscpuSchema } from '../collectors/lscpu/lscpu.schema';
import { nvidiaSchema } from '../collectors/nvidia/nvidia.schema';
import type { Composer } from './composer.types';

// teeCapable: FALSE only when the CPU isn't TEE-capable, TRUE only on the full verification chain, else PATCH (UNVERIFIED never written here); a CPLD mismatch is deliberately always PATCH.
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
    const kernelParams = kernelParamsSchema.safeParse(ctx.rawBundle.kernel_params);
    const biosVendor = ghwBios.success ? (ghwBios.data.bios.vendor ?? '').toLowerCase() : '';
    const sysManufacturer = kernelParams.success
      ? String(kernelParams.data.hardware_analysis?.system_manufacturer ?? '').toLowerCase()
      : '';

    const teeVendor =
      Object.keys(TEE_FIRMWARE).find((vendor) => biosVendor.startsWith(vendor) || sysManufacturer.startsWith(vendor)) ??
      '';
    if (!teeVendor) {
      return { serverUpdate: { teeCapable: TeeCapability.PATCH } };
    }

    const vendorFirmware = TEE_FIRMWARE[teeVendor];
    const biosVersion = ghwBios.success ? ghwBios.data.bios.version : undefined;
    if (!biosVersion || !vendorFirmware.bios.includes(biosVersion)) {
      return { serverUpdate: { teeCapable: TeeCapability.PATCH } };
    }

    if (vendorFirmware.cpld) {
      const cpld = (ctx.rawBundle as Record<string, unknown>).cpld as { cpld?: { version?: string } } | undefined;
      const cpldVersion = cpld?.cpld?.version ?? '';
      if (!vendorFirmware.cpld.includes(cpldVersion)) {
        return { serverUpdate: { teeCapable: TeeCapability.PATCH } };
      }
    }

    const nvidia = nvidiaSchema.safeParse(ctx.rawBundle.nvidia);
    // No vBIOS evidence (bad bundle or CC-mode hiding GPUs): preserve a prior TRUE — hidden GPUs never re-attest, so a downgrade would be permanent.
    if (!nvidia.success || !('gpus' in nvidia.data)) {
      const prior = ctx.device.server?.teeCapable;
      return {
        serverUpdate: { teeCapable: prior === TeeCapability.TRUE ? TeeCapability.TRUE : TeeCapability.PATCH },
      };
    }

    const vbiosVersions = [...new Set(nvidia.data.gpus.map((g) => g.vbios ?? ''))];
    if (vbiosVersions.length !== 1 || vbiosVersions[0] === '') {
      return { serverUpdate: { teeCapable: TeeCapability.PATCH } };
    }

    await this.refreshAttestation(ctx);
    const attestationStr = this.attestationIds.join(',');
    const vbios = vbiosVersions[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const vbiosPattern = new RegExp(`NV_GPU_VBIOS_[^_\\s]+_[^_\\s]+_[^_\\s]+_${vbios}`, 'i');

    return {
      serverUpdate: { teeCapable: vbiosPattern.test(attestationStr) ? TeeCapability.TRUE : TeeCapability.PATCH },
    };
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
