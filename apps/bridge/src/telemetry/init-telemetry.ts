import { initTelemetry } from '@repo/telemetry';

/** Must run before the instrumented libraries load (static import order == require order under the SWC CJS build). */
export function initBridgeTelemetry(): void {
  // Mirrors telegraf's global_tags so traces correlate with device metrics; percent-encode because a bare `,`/`=` in a value corrupts the k=v,k=v parse.
  if (!process.env.OTEL_RESOURCE_ATTRIBUTES) {
    const attributes: string[] = [];
    const bridgeId = process.env.BRIDGE_HOSTNAME?.trim();
    const zoneId = process.env.BROKKR_ZONE_ID?.trim();
    if (bridgeId) attributes.push(`bridge_id=${encodeURIComponent(bridgeId)}`);
    if (zoneId) attributes.push(`zone=${encodeURIComponent(zoneId)}`);
    if (attributes.length > 0) {
      process.env.OTEL_RESOURCE_ATTRIBUTES = attributes.join(',');
    }
  }
  initTelemetry({ serviceName: 'brokkr-bridge', preset: 'bridge' });
}
