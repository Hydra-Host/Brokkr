import { isTelemetryEnabled, resolveOtlpTracesTarget } from '@repo/telemetry';

/** Shared by ReportTraces and both agent.yaml render sites so `telemetry.traces_enabled` can't drift from what the relay forwards; requires a real OTLP target — a console-exporter bridge would only drop agent batches. */
export function traceRelayEnabled(): boolean {
  return isTelemetryEnabled() && resolveOtlpTracesTarget() !== undefined;
}
