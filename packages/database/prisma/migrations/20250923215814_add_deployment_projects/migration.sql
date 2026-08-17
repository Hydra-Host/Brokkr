-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "deploymentProjectId" TEXT;

-- CreateTable
CREATE TABLE "DeploymentProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "DeploymentProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentProject_organizationId_isDefault_idx" ON "DeploymentProject"("organizationId", "isDefault");

-- CreateIndex (Partial unique index to ensure only one default project per organization)
CREATE UNIQUE INDEX "unique_default_project_per_org" ON "DeploymentProject"("organizationId") WHERE "isDefault" = true AND "deletedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deploymentProjectId_fkey" FOREIGN KEY ("deploymentProjectId") REFERENCES "DeploymentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentProject" ADD CONSTRAINT "DeploymentProject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
