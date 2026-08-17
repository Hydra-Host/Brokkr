-- Make User.email case-insensitive (citext) so the @unique index agrees with the
-- case-insensitive email lookups, closing a duplicate-account vector where addresses
-- differing only by case could otherwise coexist across all write paths.
-- The citext extension is not Prisma-managed (no postgresqlExtensions preview), so enable it here.
-- Pre-deploy: ensure no rows collide case-insensitively or the ALTER will fail to rebuild the unique index:
--   SELECT lower(email), count(*) FROM "User" GROUP BY lower(email) HAVING count(*) > 1;
CREATE EXTENSION IF NOT EXISTS citext;

-- AlterColumn: rebuilds the existing unique index on the citext type (case-insensitive).
ALTER TABLE "User" ALTER COLUMN "email" SET DATA TYPE CITEXT;
