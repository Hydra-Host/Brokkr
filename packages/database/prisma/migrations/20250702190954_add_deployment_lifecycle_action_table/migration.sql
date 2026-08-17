-- CreateEnum
CREATE TYPE "RequestSource" AS ENUM ('UI', 'API');

-- CreateEnum
CREATE TYPE "DeploymentLifecycleActionType" AS ENUM ('Provision', 'Reprovision', 'Reboot', 'PowerOn', 'PowerOff', 'Decommission');

-- CreateTable
CREATE TABLE "DeploymentLifecycleAction" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "actionType" "DeploymentLifecycleActionType" NOT NULL,
    "source" "RequestSource" NOT NULL,
    "performedBy" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLifecycleAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_deploymentId_performedAt_idx" ON "DeploymentLifecycleAction"("deploymentId", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_deploymentId_actionType_idx" ON "DeploymentLifecycleAction"("deploymentId", "actionType");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_deploymentId_actionType_performed_idx" ON "DeploymentLifecycleAction"("deploymentId", "actionType", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_performedBy_performedAt_idx" ON "DeploymentLifecycleAction"("performedBy", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_actionType_performedAt_idx" ON "DeploymentLifecycleAction"("actionType", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_source_actionType_idx" ON "DeploymentLifecycleAction"("source", "actionType");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_performedAt_idx" ON "DeploymentLifecycleAction"("performedAt");

-- AddForeignKey
ALTER TABLE "DeploymentLifecycleAction" ADD CONSTRAINT "DeploymentLifecycleAction_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLifecycleAction" ADD CONSTRAINT "DeploymentLifecycleAction_performedBy_fkey" FOREIGN KEY ("performedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
