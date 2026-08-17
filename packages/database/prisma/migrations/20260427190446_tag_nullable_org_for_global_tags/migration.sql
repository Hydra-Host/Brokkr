-- Make Tag.organizationId nullable so global/system tags can live in Brokkr.
-- (Mirrors NetBox's global tag concept, e.g. customer-primary, north-south.)
-- AlterTable
ALTER TABLE "Tag" ALTER COLUMN "organizationId" DROP NOT NULL;

-- The composite @@unique([organizationId, name]) and @@unique([organizationId, slug])
-- treat NULL as distinct, so multiple global tags with the same name/slug would
-- be allowed without these partial indexes. Add partial uniques for the
-- organizationId IS NULL case.
CREATE UNIQUE INDEX "Tag_global_name_key" ON "Tag"("name") WHERE "organizationId" IS NULL;
CREATE UNIQUE INDEX "Tag_global_slug_key" ON "Tag"("slug") WHERE "organizationId" IS NULL;
