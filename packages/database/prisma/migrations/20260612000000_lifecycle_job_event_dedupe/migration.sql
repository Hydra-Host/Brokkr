-- CreateIndex
CREATE UNIQUE INDEX "LifecycleJobEvent_dedupe_key" ON "LifecycleJobEvent"("jobId", "sagaName", "stepName", "eventType", "status", "attempt", "occurredAt");
