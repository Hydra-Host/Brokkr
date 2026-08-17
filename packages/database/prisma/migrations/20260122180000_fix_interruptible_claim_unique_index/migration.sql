-- Drop the existing non-unique index
DROP INDEX IF EXISTS "InterruptibleClaim_deviceId_pending_unique";

-- Create a partial unique index that only allows one pending claim per device
-- This prevents race conditions where multiple users try to claim the same device
CREATE UNIQUE INDEX "InterruptibleClaim_deviceId_pending_unique" 
ON "InterruptibleClaim"("deviceId") 
WHERE status = 'Pending';
