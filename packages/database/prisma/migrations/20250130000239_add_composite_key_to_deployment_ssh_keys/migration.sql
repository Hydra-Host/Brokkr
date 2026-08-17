-- AlterTable
ALTER TABLE "DeploymentSshKeys" ADD CONSTRAINT "DeploymentSshKeys_pkey" PRIMARY KEY ("deploymentId", "sshKeyId");
