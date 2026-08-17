import { getTelemetryMeter } from '@repo/telemetry';

// Shared definition so the counter's name/description live in one place across all
// hub writers. Callers still own their source-specific add(0, ...) pre-registration.
export function createDeviceLifecycleTransitionsCounter() {
  return getTelemetryMeter('brokkr-hub').createCounter('brokkr.device_lifecycle.transitions', {
    description: 'Device lifecycle status transitions written by the hub, by target status and source',
  });
}
