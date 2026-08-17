-- CreateEnum
CREATE TYPE "TeeCapability" AS ENUM ('UNVERIFIED', 'FALSE', 'PATCH', 'TRUE');

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "teeCapable" "TeeCapability" NOT NULL DEFAULT 'UNVERIFIED';

-- Backfill: servers with teeEnabled=true were previously treated as TEE-capable.
-- Set them to PATCH so the next discovery pass can establish TRUE via attestation.
UPDATE "Server" SET "teeCapable" = 'PATCH' WHERE "teeEnabled" = true;
