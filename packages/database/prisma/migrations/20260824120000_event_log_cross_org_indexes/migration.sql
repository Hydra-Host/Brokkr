-- CreateIndex
CREATE INDEX CONCURRENTLY "EventLog_actionKey_createdAt_id_desc_idx"
  ON "EventLog"("actionKey", "createdAt" DESC, "id" DESC);
