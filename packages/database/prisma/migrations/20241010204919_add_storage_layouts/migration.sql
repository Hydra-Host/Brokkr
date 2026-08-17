-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "storageLayouts" JSONB NOT NULL DEFAULT '{}';
