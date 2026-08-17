-- CreateTable
CREATE TABLE "readonly"."NetboxOrganization" (
    "tenantId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdated" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetboxOrganization_pkey" PRIMARY KEY ("tenantId")
);
