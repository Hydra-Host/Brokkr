import { renderEnv, stripTrailingNewline } from './env';
import fallbackGrubTemplate from './templates/fallback-grub.cfg.njk';
import grubDefaultsTemplate from './templates/grub.cfg.njk';

export interface GrubRenderInput {
  gpuModel?: string | undefined;
  pciReallocOff: boolean;
  serialPorts?: { port: string; baud?: number | undefined } | undefined;
}

export function renderGrubDefaults(input: { grub: GrubRenderInput; roceIommu: boolean }): string {
  const { grub, roceIommu } = input;
  return stripTrailingNewline(
    renderEnv.renderString(grubDefaultsTemplate, {
      gpu_model: grub.gpuModel ?? null,
      pci_realloc_off: grub.pciReallocOff,
      roce_iommu: roceIommu,
      serial_ports: grub.serialPorts ? { port: grub.serialPorts.port, baud: grub.serialPorts.baud ?? null } : null,
    }),
  );
}

export function renderFallbackGrub(input: { distro: string; arch: string }): string {
  return stripTrailingNewline(
    renderEnv.renderString(fallbackGrubTemplate, {
      distro: input.distro,
      arch: input.arch,
    }),
  );
}
