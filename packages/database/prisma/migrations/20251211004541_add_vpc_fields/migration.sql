-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "netboxPrivateIpAddressId" INTEGER,
ADD COLUMN     "netboxPublicIpAddressId" INTEGER;

-- AlterTable
ALTER TABLE "DeviceMetadata" ADD COLUMN     "netrisDeviceId" INTEGER;

-- CreateTable
CREATE TABLE "Vpc" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "dateDeleted" TIMESTAMP(3),
    "netrisTenantId" INTEGER NOT NULL,
    "netboxTenantId" INTEGER NOT NULL,
    "netrisVpcId" INTEGER NOT NULL,
    "netboxVrfId" INTEGER NOT NULL,
    "netboxGatewayIpAddressId" INTEGER NOT NULL,
    "netboxGatewayId" INTEGER NOT NULL,
    "netboxAllocationPrefixId" INTEGER NOT NULL,
    "netboxSubnetPrefixId" INTEGER NOT NULL,
    "netrisVnetId" INTEGER NOT NULL,

    CONSTRAINT "Vpc_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Vpc" ADD CONSTRAINT "Vpc_id_fkey" FOREIGN KEY ("id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
