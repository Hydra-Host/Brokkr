-- Drops any copy left by master's non-concurrent migration or by db:push, including an INVALID one
-- from a failed build, so the rebuild that follows needs no IF NOT EXISTS to hide behind.
DROP INDEX CONCURRENTLY IF EXISTS "EventLogAccessBucket_createdAt_idx";
