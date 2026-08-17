-- CreateTable
CREATE TABLE "DeploymentSshKeys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sshKeyId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentSshKeys_id_key" ON "DeploymentSshKeys"("id");

-- AddForeignKey
ALTER TABLE "DeploymentSshKeys" ADD CONSTRAINT "DeploymentSshKeys_sshKeyId_fkey" FOREIGN KEY ("sshKeyId") REFERENCES "SshKeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSshKeys" ADD CONSTRAINT "DeploymentSshKeys_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
