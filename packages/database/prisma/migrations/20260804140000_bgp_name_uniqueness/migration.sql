CREATE UNIQUE INDEX "BgpPeerGroup_organizationId_name_key"
ON "BgpPeerGroup"("organizationId", "name");

CREATE UNIQUE INDEX "BgpPeerGroup_global_name_key"
ON "BgpPeerGroup"("name")
WHERE "organizationId" IS NULL;

CREATE UNIQUE INDEX "BgpSession_organizationId_name_key"
ON "BgpSession"("organizationId", "name");

CREATE UNIQUE INDEX "BgpSession_global_name_key"
ON "BgpSession"("name")
WHERE "organizationId" IS NULL;
