-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "requireBuyerConsentOnPolicy" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OrganizationSupplierPolicy" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "OrganizationSupplierPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationSupplierPolicy_organizationId_idx" ON "OrganizationSupplierPolicy"("organizationId");

-- AddForeignKey
ALTER TABLE "OrganizationSupplierPolicy" ADD CONSTRAINT "OrganizationSupplierPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
