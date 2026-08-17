-- CreateEnum
CREATE TYPE "InterruptibleClaimStatus" AS ENUM ('Pending', 'Complete');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'Interrupted';

-- CreateTable
CREATE TABLE "InterruptibleClaim" (
    "id" TEXT NOT NULL,
    "deploymentName" TEXT NOT NULL,
    "status" "InterruptibleClaimStatus" NOT NULL,
    "interruptAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterruptibleClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterruptibleClaim_deviceId_pending_unique" ON "InterruptibleClaim"("deviceId");

-- AddForeignKey
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
