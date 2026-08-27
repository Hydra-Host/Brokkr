import { registerArchitectureCollector } from './architecture';
import { registerBdiCollector } from './bdi';
import { registerBmcCollector } from './bmc';
import { registerCollectAll } from './collect-all';
import { registerDmidecodeCollector } from './dmidecode';
import { registerEfiCollector } from './efi';
import { registerEfibootmgrCollector } from './efibootmgr';
import { registerGhwCollector } from './ghw';
import { registerIbDataCollector } from './ib-data';
import { registerIpCollector } from './ip';
import { registerIsVirtualCollector } from './is-virtual';
import { registerKernelParamsCollector } from './kernel-params';
import { registerLldpCollector } from './lldp';
import { registerLsblkCollector } from './lsblk';
import { registerLscpuCollector } from './lscpu';
import { registerLshwCollector } from './lshw';
import { registerLstopoCollector } from './lstopo';
import { registerMemoryCollector } from './memory';
import { registerNvidiaCollector } from './nvidia';
import { registerNvidiaDetailedCollector } from './nvidia-detailed';
import { registerPublicIpCollector } from './public-ip';
import { registerRouteCollector } from './route';
import { registerSecureBootCollector } from './secure-boot';
import { registerSerialPortsCollector } from './serial-ports';
import { registerVersionCollector } from './version';
import { registerVirtualizationCollector } from './virtualization';

export function registerCollectionOperations(agentVersion: string, snapshotDir: string): void {
  registerArchitectureCollector();
  registerVersionCollector(agentVersion);
  registerEfiCollector();
  registerIpCollector();
  registerIsVirtualCollector();
  registerLshwCollector();
  registerLstopoCollector();
  registerLldpCollector();
  registerBdiCollector();
  registerLsblkCollector();
  registerLscpuCollector();
  registerPublicIpCollector();
  registerRouteCollector();
  registerVirtualizationCollector();
  registerBmcCollector();
  registerGhwCollector();
  registerIbDataCollector();
  registerNvidiaCollector();
  registerDmidecodeCollector();
  registerEfibootmgrCollector();
  registerMemoryCollector();
  registerKernelParamsCollector();
  registerNvidiaDetailedCollector();
  registerSerialPortsCollector();
  registerSecureBootCollector();

  // Must be registered last — looks up all per-collector handlers by name.
  registerCollectAll(snapshotDir);
}
