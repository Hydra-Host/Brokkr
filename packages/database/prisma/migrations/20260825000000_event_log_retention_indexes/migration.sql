-- A multi-statement migration file executes inside a transaction, and CREATE INDEX
-- CONCURRENTLY cannot run in one. Do not add a second statement here.
CREATE INDEX CONCURRENTLY "EventLog_createdAt_id_desc_idx" ON "EventLog"("createdAt" DESC, "id" DESC);
