import { registerCcModeChecker } from './ccMode';
import { registerRunBenchmarks } from './runBenchmarks';

export function registerBenchmarkOperations(): void {
  registerCcModeChecker();
  registerRunBenchmarks();
}
