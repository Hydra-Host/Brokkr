-- CreateEnum
CREATE TYPE "OrganizationSiteContactType" AS ENUM ('Main', 'Technical');

-- CreateEnum
CREATE TYPE "NetworkType" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "BridgePackage" AS ENUM ('lite', 'pro');

-- CreateEnum
CREATE TYPE "PrefixType" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "PrefixRole" AS ENUM ('primary', 'management');

-- CreateTable
CREATE TABLE "OrganizationSiteContact" (
    "id" TEXT NOT NULL,
    "siteId" INTEGER NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactType" "OrganizationSiteContactType" NOT NULL,
    "isShippingContact" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "OrganizationSiteContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneRequest" (
    "id" TEXT NOT NULL,
    "siteId" INTEGER NOT NULL,
    "dateApproved" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "bridgePackage" "BridgePackage" NOT NULL,
    "networkType" "NetworkType" NOT NULL,
    "prefixes" JSONB NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "ZoneRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationSiteContact_siteId_idx" ON "OrganizationSiteContact"("siteId");

-- CreateIndex
CREATE INDEX "ZoneRequest_siteId_idx" ON "ZoneRequest"("siteId");

-- AddForeignKey
ALTER TABLE "OrganizationSiteContact" ADD CONSTRAINT "OrganizationSiteContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRequest" ADD CONSTRAINT "ZoneRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
