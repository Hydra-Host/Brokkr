// Must stay the first import in main.ts, and imports here must stay @repo/telemetry only — anything else loads before instrumentation and silently escapes tracing.
import { initTelemetry } from '@repo/telemetry';

initTelemetry({ serviceName: 'brokkr-hub', preset: 'hub' });
