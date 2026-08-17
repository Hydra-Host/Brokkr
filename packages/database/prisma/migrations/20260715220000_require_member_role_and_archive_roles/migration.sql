-- AlterTable
ALTER TABLE "OrganizationMemberRole" ADD COLUMN "archivedAt" TIMESTAMP(3);

DO $$
DECLARE
  invalid_roles text;
BEGIN
  SELECT string_agg(format('%s (found %s)', required.slug, required.found), ', ' ORDER BY required.slug)
  INTO invalid_roles
  FROM (
    SELECT expected.slug, count(r.id) AS found
    FROM (VALUES ('owner'), ('admin'), ('member')) AS expected(slug)
    LEFT JOIN "OrganizationMemberRole" r
      ON r."slug" = expected.slug
      AND r."isSystem" = true
      AND r."organizationId" IS NULL
      AND r."archivedAt" IS NULL
    GROUP BY expected.slug
    HAVING count(r.id) <> 1
  ) required;

  IF invalid_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Member role backfill requires exactly one active global system role per slug: %', invalid_roles;
  END IF;
END $$;

UPDATE "Member" m
SET "assignedRoleId" = r."id"
FROM "OrganizationMemberRole" r
WHERE m."assignedRoleId" IS NULL
  AND r."isSystem" = true
  AND r."organizationId" IS NULL
  AND r."archivedAt" IS NULL
  AND r."slug" = CASE m."role"::text
    WHEN 'Owner' THEN 'owner'
    WHEN 'SuperAdmin' THEN 'admin'
    WHEN 'Admin' THEN 'admin'
    WHEN 'Member' THEN 'member'
  END;

DO $$
DECLARE
  remaining integer;
  unmapped_roles text;
BEGIN
  SELECT count(*), string_agg(DISTINCT m."role"::text, ', ' ORDER BY m."role"::text)
  INTO remaining, unmapped_roles
  FROM "Member" m
  WHERE m."assignedRoleId" IS NULL;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Member assignedRoleId backfill incomplete: % row(s) could not be mapped (legacy roles: %)',
      remaining,
      coalesce(unmapped_roles, '<null>');
  END IF;
END $$;

ALTER TABLE "Member"
  ADD CONSTRAINT "Member_assignedRoleId_not_null" CHECK ("assignedRoleId" IS NOT NULL) NOT VALID;
ALTER TABLE "Member" VALIDATE CONSTRAINT "Member_assignedRoleId_not_null";
ALTER TABLE "Member" ALTER COLUMN "assignedRoleId" SET NOT NULL;
ALTER TABLE "Member" DROP CONSTRAINT "Member_assignedRoleId_not_null";

ALTER TABLE "Member" DROP CONSTRAINT "Member_assignedRoleId_fkey";
ALTER TABLE "Member"
  ADD CONSTRAINT "Member_assignedRoleId_fkey"
  FOREIGN KEY ("assignedRoleId") REFERENCES "OrganizationMemberRole"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
