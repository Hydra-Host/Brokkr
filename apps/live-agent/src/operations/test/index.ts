import { registerConnectivityTest } from './connectivity';
import { registerPerformanceTest } from './performance';
import { registerRunTestSuite } from './runTestSuite';
import { registerSecurityTest } from './security';
import { registerStressTest } from './stress';

export function registerTestOperations(): void {
  registerConnectivityTest();
  registerStressTest();
  registerPerformanceTest();
  registerSecurityTest();
  registerRunTestSuite();
}
