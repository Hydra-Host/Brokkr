-- AlterTable
ALTER TABLE "OpenmeterWebhookEvent" ADD COLUMN     "invoiceExternalId" TEXT;

-- CreateIndex
CREATE INDEX "OpenmeterWebhookEvent_invoiceExternalId_timestamp_idx" ON "OpenmeterWebhookEvent"("invoiceExternalId", "timestamp");
