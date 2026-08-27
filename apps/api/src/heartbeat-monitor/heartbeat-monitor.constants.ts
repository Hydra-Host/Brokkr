export function formatZone(zoneId: string, zoneName?: string | null): string {
  return zoneName ?? zoneId;
}

// A single bridge must be absent from presence this long before bridge.alert fires
// (rides out restarts/redeploys; whole-zone outages are covered by zone.alert instead).
export const BRIDGE_OFFLINE_ALERT_AFTER_MS = 10 * 60 * 1000;
