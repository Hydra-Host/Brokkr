/*
  Warnings:

  - You are about to drop the column `email` on the `ReservationInvite` table. All the data in the column will be lost.
  - Added the required column `inviteeEmail` to the `ReservationInvite` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable

ALTER TABLE "ReservationInvite" ALTER COLUMN "email" SET NOT NULL;
ALTER TABLE "ReservationInvite" RENAME COLUMN "email" TO "inviteeEmail";
ALTER TABLE "ReservationInvite" ADD COLUMN "inviterEmail" TEXT NOT NULL DEFAULT '';


