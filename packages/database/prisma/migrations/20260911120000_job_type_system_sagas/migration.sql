-- AlterEnum
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'InventoryCollection';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'Benchmarks';
