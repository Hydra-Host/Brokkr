-- CreateEnum
CREATE TYPE "AdminLifecycleRequestType" AS ENUM ('DECOMMISSION', 'REPROVISION', 'PROVISION');

-- CreateEnum
CREATE TYPE "AdminLifecycleRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED');

-- CreateTable
CREATE TABLE "AdminLifecycleRequest" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" "AdminLifecycleRequestType" NOT NULL,
    "requestBody" JSONB NOT NULL,
    "status" "AdminLifecycleRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminLifecycleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminLifecycleRequest_deploymentId_idx" ON "AdminLifecycleRequest"("deploymentId");

-- CreateIndex
CREATE INDEX "AdminLifecycleRequest_status_idx" ON "AdminLifecycleRequest"("status");

-- AddForeignKey
ALTER TABLE "AdminLifecycleRequest" ADD CONSTRAINT "AdminLifecycleRequest_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminLifecycleRequest" ADD CONSTRAINT "AdminLifecycleRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminLifecycleRequest" ADD CONSTRAINT "AdminLifecycleRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
