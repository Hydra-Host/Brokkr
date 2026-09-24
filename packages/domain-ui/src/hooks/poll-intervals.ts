// TTL-backed Redis reads poll; Postgres-backed lists refresh on SSE and poll only while a job is open
export const BOOT_TRAIL_POLL_MS = 30_000;
export const HEALTH_SUMMARY_POLL_MS = 60_000;
export const OPEN_JOB_POLL_MS = 10_000;
