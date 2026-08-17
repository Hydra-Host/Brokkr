/*
  Warnings:

  - You are about to drop the column `organization` on the `TenantRequest` table. All the data in the column will be lost.
  - You are about to drop the column `tenant` on the `TenantRequest` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[slug]` on the table `Organization` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[organizationId,tenantId]` on the table `TenantRequest` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `organizationId` to the `TenantRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenantId` to the `TenantRequest` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "TenantRequest_organization_tenant_key";

-- AlterTable
ALTER TABLE "TenantRequest" 
RENAME COLUMN "organization" to "organizationId";

ALTER TABLE "TenantRequest"
RENAME COLUMN "tenant" to "tenantId";


-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "TenantRequest_organizationId_tenantId_key" ON "TenantRequest"("organizationId", "tenantId");

-- AddForeignKey
ALTER TABLE "BillingInformation" ADD CONSTRAINT "BillingInformation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureFlags" ADD CONSTRAINT "FeatureFlags_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontSettings" ADD CONSTRAINT "StorefrontSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantRequest" ADD CONSTRAINT "TenantRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SSHKeyPair" ADD CONSTRAINT "SSHKeyPair_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
