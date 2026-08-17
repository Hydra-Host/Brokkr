-- `isOwnerCapable` requires every catalog permission, so a catalog addition that
-- never reaches the DB silently zeroes owner capability in every org.

-- The RBAC seed is not part of the deploy (docker-entrypoint.sh migrates only;
-- boot-time seedRbac is auth-bypass gated), so the grant must land here.

-- Dev and stg already hold this row from manual seed runs.
INSERT INTO "Permission" ("id", "resource", "action", "description", "createdAt")
VALUES (gen_random_uuid(), 'event-log', 'access', 'View the organization event log', now())
ON CONFLICT ("resource", "action") DO UPDATE SET "description" = EXCLUDED."description";

-- Members are assigned directly to the global system templates (no clone at org
-- creation), so granting here covers existing and future orgs.
INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r.id, p.id
FROM "OrganizationMemberRole" r
CROSS JOIN "Permission" p
WHERE p."resource" = 'event-log' AND p."action" = 'access'
  AND r."isSystem" = true AND r."organizationId" IS NULL
  AND r."archivedAt" IS NULL
  -- Excludes `member`: the action is `access`, not `read`.
  AND r."slug" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Customer-created owner-capable roles are otherwise permanently bricked: the
-- capability flip is forbidden and no actor still holds the key to repair it.

-- Scoped by the owner-capability marker, not by slug — assertOwnerPermissionShape
-- only ever grants `organization:manage-owners` as part of an owner-capable set.
INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r.id, p.id
FROM "OrganizationMemberRole" r
CROSS JOIN "Permission" p
WHERE p."resource" = 'event-log' AND p."action" = 'access'
  AND r."isSystem" = false AND r."organizationId" IS NOT NULL
  AND r."archivedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "RolePermission" rp
    JOIN "Permission" mo ON mo.id = rp."permissionId"
    WHERE rp."roleId" = r.id AND mo."resource" = 'organization' AND mo."action" = 'manage-owners'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
