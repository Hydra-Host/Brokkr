-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "dateDeleted" TIMESTAMP(3),
    "locationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "vpcId" TEXT NOT NULL,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterDeployment" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clusterId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,

    CONSTRAINT "ClusterDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cluster_vpcId_idx" ON "Cluster"("vpcId");

-- CreateIndex
CREATE INDEX "ClusterDeployment_clusterId_idx" ON "ClusterDeployment"("clusterId");

-- CreateIndex
CREATE INDEX "ClusterDeployment_deploymentId_idx" ON "ClusterDeployment"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterDeployment_clusterId_deploymentId_key" ON "ClusterDeployment"("clusterId", "deploymentId");

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_vpcId_fkey" FOREIGN KEY ("vpcId") REFERENCES "Vpc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterDeployment" ADD CONSTRAINT "ClusterDeployment_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterDeployment" ADD CONSTRAINT "ClusterDeployment_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
