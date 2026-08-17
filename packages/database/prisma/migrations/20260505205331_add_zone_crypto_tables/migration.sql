-- CreateTable
CREATE TABLE "ZoneRegistrationToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedZonePub" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "ZoneRegistrationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneEnrollment" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "zonePub" BYTEA NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedTokenId" TEXT,

    CONSTRAINT "ZoneEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZoneRegistrationToken_tokenHash_key" ON "ZoneRegistrationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ZoneRegistrationToken_zoneId_idx" ON "ZoneRegistrationToken"("zoneId");

-- CreateIndex
CREATE INDEX "ZoneRegistrationToken_expiresAt_idx" ON "ZoneRegistrationToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneEnrollment_zoneId_key" ON "ZoneEnrollment"("zoneId");

-- AddForeignKey
ALTER TABLE "ZoneRegistrationToken" ADD CONSTRAINT "ZoneRegistrationToken_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRegistrationToken" ADD CONSTRAINT "ZoneRegistrationToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneEnrollment" ADD CONSTRAINT "ZoneEnrollment_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
