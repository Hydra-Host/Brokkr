-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "stripeConnectAccountId" TEXT,
ADD COLUMN     "stripeOnboardingCompleted" BOOLEAN NOT NULL DEFAULT false;
