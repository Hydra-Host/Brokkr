-- Remove later-created duplicates, keeping the oldest per (prefixListId, sequence)
DELETE FROM "PrefixListRule"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY "prefixListId", sequence
             ORDER BY "createdAt" ASC
           ) AS rn
    FROM "PrefixListRule"
  ) ranked
  WHERE rn > 1
);

UPDATE "PrefixListRule" SET action = lower(action);

ALTER TABLE "PrefixListRule"
ADD CONSTRAINT "PrefixListRule_action_check"
CHECK (action IN ('permit', 'deny'));

CREATE UNIQUE INDEX "PrefixListRule_prefixListId_sequence_key"
ON "PrefixListRule"("prefixListId", "sequence");

DROP INDEX IF EXISTS "PrefixListRule_prefixListId_idx";
