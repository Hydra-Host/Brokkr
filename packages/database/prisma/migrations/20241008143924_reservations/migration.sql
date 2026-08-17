-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "askPrice" INTEGER NOT NULL,
    "salePrice" INTEGER,
    "email" TEXT,
    "dateAccepted" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "dateExpires" TIMESTAMP(3) NOT NULL,
    "dateUpdated" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
