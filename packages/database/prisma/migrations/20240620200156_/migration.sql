/*
  Warnings:

  - You are about to drop the column `organizationId` on the `TenantRequest` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[organization,tenant]` on the table `TenantRequest` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `organization` to the `TenantRequest` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "TenantRequest_organizationId_tenant_key";

-- AlterTable
ALTER TABLE "TenantRequest" DROP COLUMN "organizationId",
ADD COLUMN     "organization" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TenantRequest_organization_tenant_key" ON "TenantRequest"("organization", "tenant");
