-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "assignedRoleId" TEXT;

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMemberRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT,
    "templateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMemberRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Permission_resource_action_key" ON "Permission"("resource", "action");

-- CreateIndex
CREATE INDEX "OrganizationMemberRole_organizationId_idx" ON "OrganizationMemberRole"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMemberRole_slug_organizationId_key" ON "OrganizationMemberRole"("slug", "organizationId");

-- CreateIndex
CREATE INDEX "RolePermission_roleId_idx" ON "RolePermission"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "Member_assignedRoleId_idx" ON "Member"("assignedRoleId");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_assignedRoleId_fkey" FOREIGN KEY ("assignedRoleId") REFERENCES "OrganizationMemberRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMemberRole" ADD CONSTRAINT "OrganizationMemberRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMemberRole" ADD CONSTRAINT "OrganizationMemberRole_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrganizationMemberRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "OrganizationMemberRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Data migration: system roles + member backfill.
-- Self-contained so the deploy needs no ordering against the permissions seed:
-- the four system role rows are created here (the seed, permissions.ts, adopts
-- them by slug and reconciles names/descriptions + attaches permission sets),
-- then every existing member's assignedRoleId is backfilled from the legacy
-- enum. Authorization reads assignedRole only — no enum fallback — so the
-- backfill must be complete; the DO block aborts the migration otherwise.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "OrganizationMemberRole" ("id", "name", "slug", "description", "isSystem", "organizationId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), v.name, v.slug, v.description, true, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('Owner', 'owner', 'Full control over the organization'),
  ('Admin', 'admin', 'Full administrative control'),
  ('Member', 'member', 'Read access to most resources, can create deployments and projects')
) AS v(name, slug, description)
WHERE NOT EXISTS (
  SELECT 1 FROM "OrganizationMemberRole" r
  WHERE r."slug" = v.slug AND r."isSystem" = true AND r."organizationId" IS NULL
);

UPDATE "Member" m
SET "assignedRoleId" = r."id"
FROM "OrganizationMemberRole" r
WHERE m."assignedRoleId" IS NULL
  AND r."isSystem" = true
  AND r."organizationId" IS NULL
  AND r."slug" = CASE m."role"::text
    WHEN 'Owner' THEN 'owner'
    WHEN 'SuperAdmin' THEN 'admin'
    WHEN 'Admin' THEN 'admin'
    WHEN 'Member' THEN 'member'
  END;

-- SuperAdmin is collapsed into Admin. For envs that seeded the retired
-- super-admin system role before the collapse: remap its members to admin,
-- then drop the role (and its permissions). Idempotent — no-op once gone.
UPDATE "Member" m
SET "assignedRoleId" = admin_role."id"
FROM "OrganizationMemberRole" sa, "OrganizationMemberRole" admin_role
WHERE m."assignedRoleId" = sa."id"
  AND sa."slug" = 'super-admin' AND sa."isSystem" = true AND sa."organizationId" IS NULL
  AND admin_role."slug" = 'admin' AND admin_role."isSystem" = true AND admin_role."organizationId" IS NULL;

DELETE FROM "RolePermission"
WHERE "roleId" IN (
  SELECT "id" FROM "OrganizationMemberRole"
  WHERE "slug" = 'super-admin' AND "isSystem" = true AND "organizationId" IS NULL
);
DELETE FROM "OrganizationMemberRole"
WHERE "slug" = 'super-admin' AND "isSystem" = true AND "organizationId" IS NULL;

DO $$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining FROM "Member" WHERE "assignedRoleId" IS NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'RBAC backfill incomplete: % member(s) have no assignedRoleId', remaining;
  END IF;
END $$;
