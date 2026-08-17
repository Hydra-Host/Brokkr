-- CreateTable
CREATE TABLE "BillingInformation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,

    CONSTRAINT "BillingInformation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlags" (
    "organizationId" TEXT NOT NULL,
    "storefront" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "PreOrderInventory" (
    "id" TEXT NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "collection" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "gpuName" TEXT NOT NULL,
    "totalInventoryCount" INTEGER NOT NULL,
    "interconnectNetwork" TEXT NOT NULL,
    "nodeRamAmount" INTEGER NOT NULL,
    "coresPerNode" INTEGER NOT NULL,
    "nodeStorageAmount" INTEGER NOT NULL,
    "geoLocation" TEXT NOT NULL,
    "clusterInterface" TEXT NOT NULL,
    "minimumCardQuantity" INTEGER,
    "minimalTerm" TEXT,
    "monthOfAvailability" TEXT NOT NULL,
    "shortTermPriceAmount" DECIMAL(65,30) NOT NULL,
    "longTermPriceAmount" DECIMAL(65,30) NOT NULL,
    "details" TEXT,
    "priceFrequency" TEXT NOT NULL DEFAULT 'hour',
    "fulfillment" TEXT NOT NULL DEFAULT 'rent',

    CONSTRAINT "PreOrderInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SshKeys" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "SshKeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorefrontSettings" (
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoFileName" TEXT NOT NULL,
    "stylesFileName" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "UserBlocklist" (
    "userId" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlocklist_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingInformation_organizationId_key" ON "BillingInformation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInformation_stripeCustomerId_key" ON "BillingInformation"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlags_organizationId_key" ON "FeatureFlags"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontSettings_organizationId_key" ON "StorefrontSettings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontSettings_slug_key" ON "StorefrontSettings"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UserBlocklist_userId_key" ON "UserBlocklist"("userId");

