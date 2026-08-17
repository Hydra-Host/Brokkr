CREATE UNIQUE INDEX "PrefixList_organizationId_name_ci_key"
ON "PrefixList"("organizationId", lower("name"))
WHERE "organizationId" IS NOT NULL;

CREATE UNIQUE INDEX "PrefixList_global_name_ci_key"
ON "PrefixList"(lower("name"))
WHERE "organizationId" IS NULL;
