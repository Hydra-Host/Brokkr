export function formatZone(zoneId: string, zoneName?: string | null): string {
  return zoneName ?? zoneId;
}
