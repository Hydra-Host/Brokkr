-- A physical port hosts at most one cable end. Enforce this at the DB so a
-- concurrent create cannot terminate two cables on the same port. Cable has no
-- soft-delete and CableTermination cascade-deletes with it, so a plain unique
-- index is correct — deleting a cable frees its ports with no lingering rows.
--
-- Replaces the plain lookup index of the same columns; the unique index also
-- serves that lookup.
DROP INDEX "CableTermination_terminationType_terminationId_idx";

CREATE UNIQUE INDEX "CableTermination_terminationType_terminationId_key"
ON "CableTermination" ("terminationType", "terminationId");
