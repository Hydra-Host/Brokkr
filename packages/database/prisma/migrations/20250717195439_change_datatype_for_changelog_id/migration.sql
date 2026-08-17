/*
  Warnings:

  - The primary key for the `Changelog` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "Changelog" DROP CONSTRAINT "Changelog_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Changelog_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Changelog_id_seq";
