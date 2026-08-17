/*
  Warnings:

  - A unique constraint covering the columns `[offset]` on the table `KafkaEvent` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[indempotencyKey]` on the table `KafkaEvent` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "KafkaEvent_offset_key" ON "KafkaEvent"("offset");

-- CreateIndex
CREATE UNIQUE INDEX "KafkaEvent_indempotencyKey_key" ON "KafkaEvent"("indempotencyKey");
