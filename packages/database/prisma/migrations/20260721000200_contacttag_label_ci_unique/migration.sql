-- Enforce case-insensitive uniqueness on ContactTag.label at the DB level so the
-- service's case-insensitive assertLabelUnique can't be bypassed by a concurrent
-- create of a case-variant (e.g. "Main"/"main") or by direct SQL. Prisma can't
-- express a functional index, so it lives in raw SQL and the model drops @unique.
DROP INDEX "ContactTag_label_key";
CREATE UNIQUE INDEX "ContactTag_label_key" ON "ContactTag"(lower("label"));
