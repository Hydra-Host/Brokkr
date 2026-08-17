-- AlterTable
ALTER TABLE "Changelog" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "actorType" "RequestSource",
ADD COLUMN     "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "Changelog_organizationId_idx" ON "Changelog"("organizationId");
