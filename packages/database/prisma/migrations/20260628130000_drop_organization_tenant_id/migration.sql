-- tenantId was a NetBox-era placeholder on Organization with no remaining
-- consumer: the bridge lifecycle thread that parsed it was removed, and the
-- operator/seed/e2e paths now key on id / isInstanceOperator. Drop the column
-- (its unique index drops with it).
ALTER TABLE "Organization" DROP COLUMN "tenantId";
