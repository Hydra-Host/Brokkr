-- AlterTable
ALTER TABLE "ReservationInvite" ADD COLUMN     "inviteeOrganizationId" TEXT,
ALTER COLUMN "inviteeEmail" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ReservationInvite" ADD CONSTRAINT "ReservationInvite_inviteeOrganizationId_fkey" FOREIGN KEY ("inviteeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
