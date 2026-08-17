/*
  Warnings:

  - Changed the type of `topic` on the `KafkaEvent` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "KafkaTopic" AS ENUM ('DevicesMonitor');

-- AlterTable
ALTER TABLE "KafkaEvent" DROP COLUMN "topic",
ADD COLUMN     "topic" "KafkaTopic" NOT NULL;
