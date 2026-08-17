-- AlterTable
ALTER TABLE "TwoFactor" ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- Backfill: `verified` means TOTP setup was completed. Pre-1.6 rows have no such flag,
-- but User.twoFactorEnabled was only set true on completed setup — use it as the source
-- of truth. Rows from abandoned enrollments must be verified=false, otherwise verifyTotp
-- skips the enable step (never sets twoFactorEnabled) and the user silently has no 2FA.
UPDATE "TwoFactor" t
SET "verified" = false
FROM "User" u
WHERE u."id" = t."userId"
  AND u."twoFactorEnabled" IS NOT TRUE;
