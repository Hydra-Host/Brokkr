-- Standalone by necessity: Postgres refuses to use a new enum value in the transaction that adds
-- it, so any migration writing MIRROR rows must come after this one.
ALTER TYPE "EventDurability" ADD VALUE IF NOT EXISTS 'MIRROR' AFTER 'POST_COMMIT';
