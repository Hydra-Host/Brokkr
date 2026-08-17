-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "ReservationInvite" ALTER COLUMN "deviceId" DROP NOT NULL,
ALTER COLUMN "askPrice" DROP NOT NULL;
