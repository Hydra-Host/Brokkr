import { registerBatteryDiagnostic } from './battery';
import { registerGpuDiagnostic } from './gpu';
import { registerMemoryDiagnostic } from './memory';
import { registerNetworkDiagnostic } from './network';
import { registerPerformanceDiagnostic } from './performance';
import { registerPowerDiagnostic } from './power';
import { registerRunAllDiagnostic } from './run-all';
import { registerStorageDiagnostic } from './storage';
import { registerSystemDiagnostic } from './system';
import { registerThermalDiagnostic } from './thermal';
import { registerWriteSerialTokensDiagnostic } from './write-serial-tokens';

export function registerDiagnosticOperations(): void {
  registerGpuDiagnostic();
  registerThermalDiagnostic();
  registerStorageDiagnostic();
  registerMemoryDiagnostic();
  registerNetworkDiagnostic();
  registerPerformanceDiagnostic();
  registerPowerDiagnostic();
  registerSystemDiagnostic();
  registerBatteryDiagnostic();
  registerRunAllDiagnostic();
  registerWriteSerialTokensDiagnostic();
}
