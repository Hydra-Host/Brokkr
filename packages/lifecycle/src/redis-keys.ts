// Spoke-written per-plan log stores under the zone prefix; segments mirror apps/bridge/src/common/redis/redis-keys.ts
export const jobRedisKeys = {
  solLogs: (zonePrefix: string, planId: string): string => `${zonePrefix}:sol:logs:${planId}`,
  jobLogs: (zonePrefix: string, planId: string): string => `${zonePrefix}:job:logs:${planId}`,
};
