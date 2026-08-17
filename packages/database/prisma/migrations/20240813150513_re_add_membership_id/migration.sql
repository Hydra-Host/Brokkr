/*
  Warnings:

  - The primary key for the `OrganizationMembership` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `OrganizationMembership` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[id]` on the table `OrganizationMembership` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "OrganizationMembership" DROP CONSTRAINT "OrganizationMembership_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_id_key" ON "OrganizationMembership"("id");
