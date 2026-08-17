-- CreateTable
CREATE TABLE "VpcOperationCheckpoint" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "completedSteps" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VpcOperationCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VpcOperationCheckpoint_deploymentId_key" ON "VpcOperationCheckpoint"("deploymentId");

-- AddForeignKey
ALTER TABLE "VpcOperationCheckpoint" ADD CONSTRAINT "VpcOperationCheckpoint_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
