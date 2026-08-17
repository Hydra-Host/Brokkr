-- Rename timestamp columns on CloudInitTemplate
ALTER TABLE "CloudInitTemplate" RENAME COLUMN "created" TO "createdAt";
ALTER TABLE "CloudInitTemplate" RENAME COLUMN "updated" TO "updatedAt";
ALTER TABLE "CloudInitTemplate" RENAME COLUMN "deleted" TO "deletedAt";
