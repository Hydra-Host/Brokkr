-- CreateTable
CREATE TABLE "ZoneRedisCredential" (
    "zoneId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "ZoneRedisCredential_pkey" PRIMARY KEY ("zoneId")
);

-- AddForeignKey
ALTER TABLE "ZoneRedisCredential" ADD CONSTRAINT "ZoneRedisCredential_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
