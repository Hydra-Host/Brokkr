-- CreateTable
CREATE TABLE "KafkaEvent" (
    "id" TEXT NOT NULL,
    "offset" INTEGER NOT NULL,
    "topic" TEXT NOT NULL,
    "indempotencyKey" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KafkaEvent_pkey" PRIMARY KEY ("id")
);
