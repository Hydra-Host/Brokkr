-- CreateEnum
CREATE TYPE "LayerSelectionType" AS ENUM ('SINGLE_SELECT', 'MULTI_SELECT');

-- CreateEnum
CREATE TYPE "LayerRelationType" AS ENUM ('REQUIRES', 'CONFLICTS');

-- CreateTable
CREATE TABLE "LayerGroup" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "selectionType" "LayerSelectionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Layer" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "layerGroupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Layer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceOperatingSystemLayer" (
    "deviceId" TEXT NOT NULL,
    "operatingSystemId" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,

    CONSTRAINT "DeviceOperatingSystemLayer_pkey" PRIMARY KEY ("deviceId","operatingSystemId","layerId")
);

-- CreateTable
CREATE TABLE "LayerRelation" (
    "layerId" TEXT NOT NULL,
    "relatedLayerId" TEXT NOT NULL,
    "type" "LayerRelationType" NOT NULL,
    "groupId" TEXT,

    CONSTRAINT "LayerRelation_pkey" PRIMARY KEY ("layerId","relatedLayerId")
);

-- CreateTable
CREATE TABLE "InstalledLayer" (
    "deploymentId" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstalledLayer_pkey" PRIMARY KEY ("deploymentId","layerId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LayerGroup_slug_key" ON "LayerGroup"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Layer_slug_key" ON "Layer"("slug");

-- AddForeignKey
ALTER TABLE "Layer" ADD CONSTRAINT "Layer_layerGroupId_fkey" FOREIGN KEY ("layerGroupId") REFERENCES "LayerGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceOperatingSystemLayer" ADD CONSTRAINT "DeviceOperatingSystemLayer_deviceId_operatingSystemId_fkey" FOREIGN KEY ("deviceId", "operatingSystemId") REFERENCES "DeviceOperatingSystem"("deviceId", "operatingSystemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceOperatingSystemLayer" ADD CONSTRAINT "DeviceOperatingSystemLayer_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerRelation" ADD CONSTRAINT "LayerRelation_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerRelation" ADD CONSTRAINT "LayerRelation_relatedLayerId_fkey" FOREIGN KEY ("relatedLayerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledLayer" ADD CONSTRAINT "InstalledLayer_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledLayer" ADD CONSTRAINT "InstalledLayer_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
