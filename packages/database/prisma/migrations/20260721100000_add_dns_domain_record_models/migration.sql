-- CreateEnum
CREATE TYPE "DnsDomainType" AS ENUM ('FORWARD', 'REVERSE');

-- CreateEnum
CREATE TYPE "DnsRecordType" AS ENUM ('A', 'AAAA', 'PTR');

-- CreateEnum
CREATE TYPE "DnsRecordSource" AS ENUM ('MANUAL', 'AUTO');

-- CreateTable
CREATE TABLE "DnsDomain" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DnsDomainType" NOT NULL DEFAULT 'FORWARD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "DnsDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DnsRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DnsRecordType" NOT NULL,
    "value" TEXT NOT NULL,
    "source" "DnsRecordSource" NOT NULL DEFAULT 'MANUAL',
    "ttlOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "domainId" TEXT NOT NULL,
    "deviceId" TEXT,
    "ipAddressId" TEXT,

    CONSTRAINT "DnsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DnsDomain_zoneId_idx" ON "DnsDomain"("zoneId");

-- CreateIndex (partial: active rows only, allows soft-deleted name reuse)
CREATE UNIQUE INDEX "DnsDomain_active_zoneId_name_unique"
  ON "DnsDomain"("zoneId", "name")
  WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "DnsRecord_domainId_idx" ON "DnsRecord"("domainId");

-- CreateIndex
CREATE INDEX "DnsRecord_deviceId_idx" ON "DnsRecord"("deviceId");

-- CreateIndex
CREATE INDEX "DnsRecord_ipAddressId_idx" ON "DnsRecord"("ipAddressId");

-- CreateIndex (partial: active rows only, allows soft-deleted record reuse)
CREATE UNIQUE INDEX "DnsRecord_active_domainId_name_type_value_unique"
  ON "DnsRecord"("domainId", "name", "type", "value")
  WHERE "deletedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "DnsDomain" ADD CONSTRAINT "DnsDomain_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRecord" ADD CONSTRAINT "DnsRecord_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "DnsDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRecord" ADD CONSTRAINT "DnsRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRecord" ADD CONSTRAINT "DnsRecord_ipAddressId_fkey" FOREIGN KEY ("ipAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;
