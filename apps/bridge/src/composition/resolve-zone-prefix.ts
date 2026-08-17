export function resolveZonePrefix(env: NodeJS.ProcessEnv): string {
  const raw = env.BROKKR_ZONE_ID ?? process.env.BROKKR_ZONE_ID ?? '';
  return raw.trim();
}
