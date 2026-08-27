-- Bridge presence/status columns: heartbeat-sweep-materialized online
-- state, brokkr-live version, and the bridge-offline alert dedupe marker.
-- AlterTable
ALTER TABLE "Bridge" ADD COLUMN     "brokkrLiveVersion" TEXT,
ADD COLUMN     "isOnline" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastOfflineAt" TIMESTAMP(3),
ADD COLUMN     "offlineAlertSentAt" TIMESTAMP(3);
