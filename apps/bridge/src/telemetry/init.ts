// Side-effect entry for main.ts — must stay its FIRST import; guarded by __test__/telemetry-import-order.spec.ts.
import { initBridgeTelemetry } from './init-telemetry';

initBridgeTelemetry();
