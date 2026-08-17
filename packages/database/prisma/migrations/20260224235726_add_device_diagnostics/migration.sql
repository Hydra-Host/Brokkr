-- CreateEnum
CREATE TYPE "DeviceDiagnosticsType" AS ENUM ('Driver', 'Gpu', 'Nvlink', 'Lspci', 'Services', 'Kernel', 'System', 'Infiniband', 'Storage', 'Thermal', 'Cuda', 'AllDiagnostics');

-- CreateTable
CREATE TABLE "DeviceDiagnostics" (
    "id" TEXT NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "type" "DeviceDiagnosticsType" NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceDiagnostics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceDiagnostics_deviceId_idx" ON "DeviceDiagnostics"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceDiagnostics_type_idx" ON "DeviceDiagnostics"("type");

-- AddForeignKey
ALTER TABLE "DeviceDiagnostics" ADD CONSTRAINT "DeviceDiagnostics_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceMetadata"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
