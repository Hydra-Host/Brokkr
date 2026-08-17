-- A6: deployment-centric interruptible tenancy + linked jobs.
--
-- Re-homes the interruptible signal (gone with billing/ContractTerm) onto
-- Deployment and links the two interruptible jobs (outgoing decommission ->
-- incoming provision). Admin approval is tracked by AdminLifecycleRequest, not a
-- lifecycle-job phase.

-- AlterTable: per-deployment interruptible tenancy
ALTER TABLE "Deployment"
  ADD COLUMN "isInterruptible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "interruptibleNoticePeriod" INTEGER;

-- AlterTable: link the two interruptible lifecycle jobs
ALTER TABLE "LifecycleJob" ADD COLUMN "linkedJobId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleJob_linkedJobId_key" ON "LifecycleJob"("linkedJobId");
