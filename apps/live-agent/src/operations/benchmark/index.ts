import { registerCcModeChecker } from './cc-mode';
import { registerRunBenchmarks } from './run-benchmarks';

export function registerBenchmarkOperations(): void {
  registerCcModeChecker();
  registerRunBenchmarks();
}
