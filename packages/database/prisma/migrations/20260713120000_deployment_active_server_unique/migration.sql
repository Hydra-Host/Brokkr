DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "serverId" FROM "Deployment" WHERE "endDate" IS NULL GROUP BY "serverId" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot create Deployment_active_server_unique: % server(s) have multiple active (endDate IS NULL) deployments. Set endDate on the stale row of each duplicate set, then re-run. Find them: SELECT "serverId", count(*) FROM "Deployment" WHERE "endDate" IS NULL GROUP BY "serverId" HAVING count(*) > 1;', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "Deployment_active_server_unique"
ON "Deployment" ("serverId")
WHERE "endDate" IS NULL;
