-- This is an empty migration.

ALTER TABLE "KafkaEvent"
RENAME COLUMN "indempotencyKey" TO "idempotencyKey";
