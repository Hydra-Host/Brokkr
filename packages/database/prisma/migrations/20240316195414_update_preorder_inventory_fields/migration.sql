-- AlterTable
ALTER TABLE "PreOrderInventory" ADD COLUMN     "clusterNodeCount" INTEGER,
ADD COLUMN     "diskCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "gpuCount" INTEGER,
ADD COLUMN     "vCpuCount" INTEGER,
ALTER COLUMN "companyName" DROP NOT NULL;
