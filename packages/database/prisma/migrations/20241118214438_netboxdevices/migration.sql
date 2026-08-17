-- CreateTable
CREATE TABLE "readonly"."NetboxDevices" (
    "id" INTEGER NOT NULL,
    "name" TEXT,
    "tenantId" INTEGER NOT NULL,
    "cores" INTEGER,
    "location" TEXT,
    "disks" TEXT,
    "storage" TEXT,
    "gpu" TEXT,
    "memory" TEXT,
    "status" TEXT,

    CONSTRAINT "NetboxDevices_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "readonly"."NetboxDevices" ADD CONSTRAINT "NetboxDevices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "readonly"."NetboxOrganization"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
