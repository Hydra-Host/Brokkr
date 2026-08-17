-- CreateTable
CREATE TABLE "NetboxDeviceStatusChanges" (
    "id" SERIAL NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "currentStatus" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stripeProductId" TEXT,
    "stripeCustomerId" TEXT,
    "stripePriceId" TEXT,
    "organizationUserId" TEXT,
    "isInternalUser" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NetboxDeviceStatusChanges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetboxTenantGroup" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "NetboxTenantGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetboxTenant" (
    "tenantId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT,
    "displayName" TEXT,
    "groupId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdated" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetboxTenant_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "NetboxDeviceRole" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "NetboxDeviceRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetboxRegion" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "customFieldData" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "NetboxRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetboxSite" (
    "id" INTEGER NOT NULL,
    "customFieldData" JSONB NOT NULL DEFAULT '{}',
    "name" TEXT,
    "slug" TEXT,
    "status" TEXT,
    "facility" TEXT,
    "timeZone" TEXT,
    "description" TEXT,
    "physicalAddress" TEXT,
    "shippingAddress" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "groupId" INTEGER,
    "regionId" INTEGER,
    "tenantId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetboxSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetboxLocation" (
    "id" INTEGER NOT NULL,
    "customFieldData" JSONB NOT NULL DEFAULT '{}',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "siteId" INTEGER,
    "tenantId" INTEGER,
    "status" TEXT NOT NULL,
    "facility" TEXT NOT NULL,

    CONSTRAINT "NetboxLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetboxPlatform" (
    "id" INTEGER NOT NULL,
    "description" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "osDistribution" TEXT,
    "osVersion" TEXT,

    CONSTRAINT "NetboxPlatform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetboxDevices" (
    "deviceId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "serial" TEXT,
    "role" "DeviceRole" NOT NULL DEFAULT 'Baremetal',
    "siteId" INTEGER,
    "siteName" TEXT,
    "locationId" INTEGER,
    "locationName" TEXT,
    "clusterId" INTEGER,
    "clusterName" TEXT,
    "primaryIp4" TEXT,
    "primaryIp6" TEXT,
    "cpuModel" TEXT,
    "cpuThreadCount" INTEGER,
    "cpuCoreCount" INTEGER,
    "cpuPhysicalCount" INTEGER,
    "ipamConfig" JSONB DEFAULT '{}',
    "virtualNetworkConfig" JSONB DEFAULT '{}',
    "macAddress" TEXT DEFAULT '',
    "memory" INTEGER,
    "nvmeSize" INTEGER,
    "nvmeCount" INTEGER,
    "ssdSize" INTEGER,
    "ssdCount" INTEGER,
    "hddSize" INTEGER,
    "hddCount" INTEGER,
    "gpuModel" TEXT,
    "gpuCount" INTEGER,
    "storageLayouts" JSONB DEFAULT '{}',
    "netboxTenantId" INTEGER,

    CONSTRAINT "NetboxDevices_pkey" PRIMARY KEY ("deviceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "NetboxDeviceStatusChanges_requestId_key" ON "NetboxDeviceStatusChanges"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "NetboxPlatform_slug_key" ON "NetboxPlatform"("slug");

-- AddForeignKey
ALTER TABLE "NetboxTenant" ADD CONSTRAINT "NetboxTenant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "NetboxTenantGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetboxSite" ADD CONSTRAINT "NetboxSite_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "NetboxRegion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetboxSite" ADD CONSTRAINT "NetboxSite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "NetboxTenant"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetboxLocation" ADD CONSTRAINT "NetboxLocation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "NetboxSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetboxLocation" ADD CONSTRAINT "NetboxLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "NetboxTenant"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetboxDevices" ADD CONSTRAINT "NetboxDevices_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "NetboxSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetboxDevices" ADD CONSTRAINT "NetboxDevices_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "NetboxLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetboxDevices" ADD CONSTRAINT "NetboxDevices_netboxTenantId_fkey" FOREIGN KEY ("netboxTenantId") REFERENCES "NetboxTenant"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;
