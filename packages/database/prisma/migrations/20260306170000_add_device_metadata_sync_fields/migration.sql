-- AlterTable
ALTER TABLE "DeviceMetadata" ADD COLUMN "mgmtMac" TEXT,
ADD COLUMN "teeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "monitored" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "monitorPsk" TEXT,
ADD COLUMN "ipxeBuildTarget" TEXT,
ADD COLUMN "ipxeBuildVersion" TEXT;
