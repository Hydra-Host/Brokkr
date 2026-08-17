import type { Type } from '@nestjs/common';
import { ArchitectureHandler } from './architecture/architecture.handler';
import { BdiHandler } from './bdi/bdi.handler';
import { BmcHandler } from './bmc/bmc.handler';
import { CollectionMetadataHandler } from './collection_metadata/collection_metadata.handler';
import type { CollectorHandler } from './collector.types';
import { DmidecodeHandler } from './dmidecode/dmidecode.handler';
import { DmidecodeMemoryHandler } from './dmidecode_memory/dmidecode_memory.handler';
import { EfiHandler } from './efi/efi.handler';
import { EfibootmgrHandler } from './efibootmgr/efibootmgr.handler';
import { FirmwareTypeHandler } from './firmware_type/firmware_type.handler';
import { GhwBaseboardHandler } from './ghw_baseboard/ghw_baseboard.handler';
import { GhwBiosHandler } from './ghw_bios/ghw_bios.handler';
import { GhwBlockHandler } from './ghw_block/ghw_block.handler';
import { GhwChassisHandler } from './ghw_chassis/ghw_chassis.handler';
import { GhwCpuHandler } from './ghw_cpu/ghw_cpu.handler';
import { GhwGpuHandler } from './ghw_gpu/ghw_gpu.handler';
import { GhwMemoryHandler } from './ghw_memory/ghw_memory.handler';
import { GhwNetHandler } from './ghw_net/ghw_net.handler';
import { GhwPciHandler } from './ghw_pci/ghw_pci.handler';
import { GhwProductHandler } from './ghw_product/ghw_product.handler';
import { IbDataHandler } from './ib_data/ib_data.handler';
import { IpAHandler } from './ip_a/ip_a.handler';
import { KernelParamsHandler } from './kernel_params/kernel_params.handler';
import { LldpHandler } from './lldp/lldp.handler';
import { LsblkHandler } from './lsblk/lsblk.handler';
import { LscpuHandler } from './lscpu/lscpu.handler';
import { LshwHandler } from './lshw/lshw.handler';
import { NvidiaHandler } from './nvidia/nvidia.handler';
import { PublicIpHandler } from './public_ip/public_ip.handler';
import { RouteHandler } from './route/route.handler';
import { SerialPortsHandler } from './serial_ports/serial_ports.handler';
import { VirtualizationHandler } from './virtualization/virtualization.handler';

export const COLLECTOR_HANDLERS: Type<CollectorHandler<any>>[] = [
  ArchitectureHandler,
  BdiHandler,
  EfiHandler,
  FirmwareTypeHandler,
  PublicIpHandler,
  BmcHandler,
  CollectionMetadataHandler,
  GhwBaseboardHandler,
  GhwBiosHandler,
  GhwChassisHandler,
  GhwMemoryHandler,
  GhwProductHandler,
  LscpuHandler,
  RouteHandler,
  VirtualizationHandler,
  DmidecodeMemoryHandler,
  EfibootmgrHandler,
  GhwBlockHandler,
  GhwCpuHandler,
  GhwNetHandler,
  IbDataHandler,
  IpAHandler,
  LldpHandler,
  LsblkHandler,
  KernelParamsHandler,
  NvidiaHandler,
  SerialPortsHandler,
  DmidecodeHandler,
  GhwGpuHandler,
  GhwPciHandler,
  LshwHandler,
];

export { CollectorRegistry } from './collector.registry';
export * from './collector.types';
export { hardwareString } from './hardware-string';
