-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN IF NOT EXISTS "assignedRoleId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invitation_assignedRoleId_idx" ON "Invitation"("assignedRoleId");

-- AddForeignKey
ALTER TABLE "Invitation" DROP CONSTRAINT IF EXISTS "Invitation_assignedRoleId_fkey";
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_assignedRoleId_fkey" FOREIGN KEY ("assignedRoleId") REFERENCES "OrganizationMemberRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
  missing_roles text;
BEGIN
  SELECT string_agg(required.slug, ', ' ORDER BY required.slug)
  INTO missing_roles
  FROM (VALUES ('owner'), ('admin'), ('member')) AS required(slug)
  WHERE NOT EXISTS (
    SELECT 1
    FROM "OrganizationMemberRole" r
    WHERE r."slug" = required.slug
      AND r."isSystem" = true
      AND r."organizationId" IS NULL
  );

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation role backfill requires missing seeded system role(s): %', missing_roles;
  END IF;
END $$;

UPDATE "Invitation" i
SET "assignedRoleId" = r."id"
FROM "OrganizationMemberRole" r
WHERE r."isSystem" = true
  AND r."organizationId" IS NULL
  AND i."assignedRoleId" IS NULL
  AND r."slug" = CASE lower(trim(i."role"))
    WHEN 'owner' THEN 'owner'
    WHEN 'superadmin' THEN 'admin'
    WHEN 'admin' THEN 'admin'
    WHEN 'member' THEN 'member'
  END;

DO $$
DECLARE
  remaining integer;
  unmapped_roles text;
BEGIN
  SELECT count(*), string_agg(DISTINCT i."role", ', ' ORDER BY i."role")
  INTO remaining, unmapped_roles
  FROM "Invitation" i
  WHERE i."assignedRoleId" IS NULL;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Invitation assignedRoleId backfill incomplete: % row(s) could not be mapped (roles: %)',
      remaining,
      coalesce(unmapped_roles, '<null>');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Invitation"
  ALTER COLUMN "assignedRoleId" SET NOT NULL,
  DROP COLUMN IF EXISTS "role";

-- AlterTable
ALTER TABLE "OrganizationMembershipInvitation" DROP COLUMN IF EXISTS "role";
