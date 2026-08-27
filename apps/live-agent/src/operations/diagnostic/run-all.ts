import { registerOperation } from '../../dispatch/registry';

import { runBatteryDiagnostic } from './battery';
import { runGpuDiagnostic } from './gpu';
import { runMemoryDiagnostic } from './memory';
import { runNetworkDiagnostic } from './network';
import { runPerformanceDiagnostic } from './performance';
import { runPowerDiagnostic } from './power';
import { runStorageDiagnostic } from './storage';
import { runSystemDiagnostic } from './system';
import { runThermalDiagnostic } from './thermal';

const DIAGNOSTIC_RUNNERS: Array<() => Promise<Record<string, unknown>>> = [
  runGpuDiagnostic,
  runThermalDiagnostic,
  runStorageDiagnostic,
  runMemoryDiagnostic,
  runNetworkDiagnostic,
  runPerformanceDiagnostic,
  runPowerDiagnostic,
  runSystemDiagnostic,
  runBatteryDiagnostic,
];

export function registerRunAllDiagnostic(): void {
  registerOperation('diagnostic.runAll', async (_input, ctx) => {
    const settled = await Promise.allSettled(DIAGNOSTIC_RUNNERS.map((r) => r()));

    const merged: Record<string, unknown> = {};
    let successful = 0;
    let failed = 0;

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value && typeof result.value === 'object') {
        Object.assign(merged, result.value);
        successful += 1;
      } else {
        failed += 1;
      }
    }

    merged['diagnostics_metadata'] = {
      diagnostics_total: DIAGNOSTIC_RUNNERS.length,
      diagnostics_successful: successful,
      diagnostics_failed: failed,
      job_id: ctx.job_id ?? '',
    };

    return merged;
  });
}
