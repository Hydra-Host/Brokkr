-- CreateEnum
CREATE TYPE "PrefixStatus" AS ENUM ('CONTAINER', 'ACTIVE', 'RESERVED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "IpStatus" AS ENUM ('ACTIVE', 'RESERVED', 'DEPRECATED', 'DHCP');

-- CreateEnum
CREATE TYPE "AssignedObjectType" AS ENUM ('Interface', 'VirtualMachine', 'Device');

-- CreateEnum
CREATE TYPE "VlanStatus" AS ENUM ('ACTIVE', 'RESERVED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "IpRangeStatus" AS ENUM ('ACTIVE', 'RESERVED', 'DEPRECATED');

-- CreateTable
CREATE TABLE "Vrf" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rd" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Vrf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prefix" (
    "id" TEXT NOT NULL,
    "prefix" cidr NOT NULL,
    "status" "PrefixStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPool" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "vrfId" TEXT,
    "parentId" TEXT,
    "vlanId" TEXT,
    "gatewayIpId" TEXT,

    CONSTRAINT "Prefix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpAddress" (
    "id" TEXT NOT NULL,
    "address" inet NOT NULL,
    "status" "IpStatus" NOT NULL DEFAULT 'ACTIVE',
    "dnsName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "vrfId" TEXT,
    "assignedObjectType" "AssignedObjectType",
    "assignedObjectId" TEXT,

    CONSTRAINT "IpAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vid" INTEGER NOT NULL,
    "description" TEXT,
    "status" "VlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "vrfId" TEXT,

    CONSTRAINT "Vlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpRange" (
    "id" TEXT NOT NULL,
    "start" inet NOT NULL,
    "end" inet NOT NULL,
    "status" "IpRangeStatus" NOT NULL DEFAULT 'ACTIVE',
    "purpose" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "prefixId" TEXT NOT NULL,
    "vrfId" TEXT,

    CONSTRAINT "IpRange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vrf_organizationId_name_idx" ON "Vrf"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Vrf_organizationId_rd_idx" ON "Vrf"("organizationId", "rd");

-- CreateIndex
CREATE INDEX "Vrf_organizationId_idx" ON "Vrf"("organizationId");

-- CreateIndex
CREATE INDEX "Prefix_vrfId_prefix_idx" ON "Prefix"("vrfId", "prefix");

-- CreateIndex
CREATE INDEX "Prefix_organizationId_idx" ON "Prefix"("organizationId");

-- CreateIndex
CREATE INDEX "Prefix_vrfId_idx" ON "Prefix"("vrfId");

-- CreateIndex
CREATE INDEX "Prefix_parentId_idx" ON "Prefix"("parentId");

-- CreateIndex
CREATE INDEX "Prefix_vlanId_idx" ON "Prefix"("vlanId");

-- CreateIndex
CREATE INDEX "Prefix_gatewayIpId_idx" ON "Prefix"("gatewayIpId");

-- CreateIndex
CREATE INDEX "Prefix_status_idx" ON "Prefix"("status");

-- CreateIndex
CREATE INDEX "Prefix_isPool_idx" ON "Prefix"("isPool");

-- CreateIndex
CREATE INDEX "IpAddress_vrfId_address_idx" ON "IpAddress"("vrfId", "address");

-- CreateIndex
CREATE INDEX "IpAddress_organizationId_idx" ON "IpAddress"("organizationId");

-- CreateIndex
CREATE INDEX "IpAddress_vrfId_idx" ON "IpAddress"("vrfId");

-- CreateIndex
CREATE INDEX "IpAddress_status_idx" ON "IpAddress"("status");

-- CreateIndex
CREATE INDEX "IpAddress_dnsName_idx" ON "IpAddress"("dnsName");

-- CreateIndex
CREATE INDEX "IpAddress_assignedObjectType_assignedObjectId_idx" ON "IpAddress"("assignedObjectType", "assignedObjectId");

-- CreateIndex
CREATE INDEX "Vlan_organizationId_idx" ON "Vlan"("organizationId");

-- CreateIndex
CREATE INDEX "Vlan_vrfId_idx" ON "Vlan"("vrfId");

-- CreateIndex
CREATE INDEX "Vlan_status_idx" ON "Vlan"("status");

-- CreateIndex
CREATE INDEX "Vlan_organizationId_vrfId_vid_idx" ON "Vlan"("organizationId", "vrfId", "vid");

-- CreateIndex
CREATE INDEX "IpRange_organizationId_idx" ON "IpRange"("organizationId");

-- CreateIndex
CREATE INDEX "IpRange_prefixId_idx" ON "IpRange"("prefixId");

-- CreateIndex
CREATE INDEX "IpRange_vrfId_idx" ON "IpRange"("vrfId");

-- CreateIndex
CREATE INDEX "IpRange_status_idx" ON "IpRange"("status");

-- AddForeignKey
ALTER TABLE "Vrf" ADD CONSTRAINT "Vrf_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Prefix"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_vlanId_fkey" FOREIGN KEY ("vlanId") REFERENCES "Vlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_gatewayIpId_fkey" FOREIGN KEY ("gatewayIpId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_prefixId_fkey" FOREIGN KEY ("prefixId") REFERENCES "Prefix"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;
