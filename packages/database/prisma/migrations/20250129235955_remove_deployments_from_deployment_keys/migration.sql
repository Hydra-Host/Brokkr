/*
  Warnings:

  - You are about to drop the column `deploymentId` on the `DeploymentKeys` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "DeploymentKeys" DROP CONSTRAINT "DeploymentKeys_deploymentId_fkey";

-- AlterTable
ALTER TABLE "DeploymentKeys" DROP COLUMN "deploymentId";
