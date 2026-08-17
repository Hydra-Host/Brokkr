-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "bootFilename" TEXT;

-- AddCheckConstraint
ALTER TABLE "Device" ADD CONSTRAINT "Device_bootFilename_len" CHECK ("bootFilename" IS NULL OR char_length("bootFilename") <= 127);
