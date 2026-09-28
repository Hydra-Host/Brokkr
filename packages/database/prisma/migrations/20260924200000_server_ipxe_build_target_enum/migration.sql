-- AlterTable
ALTER TABLE "Server" ALTER COLUMN "ipxeBuildTarget" TYPE "IpxeBuildTarget" USING NULL;

-- CopyData
UPDATE "Server" s
SET "ipxeBuildTarget" = d."ipxeBuildTarget"
FROM "Device" d
WHERE d.id = s."deviceId"
  AND d."ipxeBuildTarget" IS NOT NULL;

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "ipxeBuildTarget";
