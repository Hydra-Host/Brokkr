-- Emit a NOTIFY on every lifecycle-relevant row change so the e2e harness can
-- record a real-time DB-change timeline (the Postgres analog of Redis keyspace
-- notifications). Channel: sim_lifecycle. Payload: compact JSON of the changed
-- lifecycle columns. Sim-only — applied on top of the hub schema via
-- stack:sql-seed, never part of brokkr-app's own migrations. Idempotent.

-- CREATE OR REPLACE FUNCTION races on pg_proc_proname_args_nsp_index when two
-- seed runs overlap; serialize concurrent applications so re-fired `task` runs
-- can't collide.
SELECT pg_advisory_lock(728310042);

CREATE OR REPLACE FUNCTION sim_lifecycle_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE payload jsonb;
BEGIN
  payload := jsonb_build_object('tbl', TG_TABLE_NAME, 'op', TG_OP);
  IF TG_TABLE_NAME = 'Server' THEN
    payload := payload || jsonb_build_object(
      'deviceId', NEW."deviceId",
      'lifecycleStatus', NEW."lifecycleStatus",
      'powerStatus', NEW."powerStatus");
  ELSIF TG_TABLE_NAME = 'Device' THEN
    payload := payload || jsonb_build_object('id', NEW.id, 'status', NEW.status, 'role', NEW.role);
  ELSIF TG_TABLE_NAME = 'Deployment' THEN
    -- Resolve deviceId (Deployment keys on serverId) so the recorder scopes it to
    -- the device, and emit base/rescue layer slugs (not ids) so the rescue-OS flip
    -- is readable. Sourced from the Layer FKs (baseLayerId/rescueLayerId), not the
    -- legacy OperatingSystem columns, so this survives the OS-table drop.
    payload := payload || jsonb_build_object(
      'deviceId', (SELECT "deviceId" FROM "Server" WHERE id = NEW."serverId"),
      'selectedOs', (SELECT slug FROM "Layer" WHERE id = NEW."baseLayerId"),
      'rescueOs', (SELECT slug FROM "Layer" WHERE id = NEW."rescueLayerId"),
      'endDate', NEW."endDate");
  ELSIF TG_TABLE_NAME = 'Job' THEN
    payload := payload || jsonb_build_object(
      'deviceId', NEW."deviceId", 'jobType', NEW."jobType", 'status', NEW.status);
  END IF;
  PERFORM pg_notify('sim_lifecycle', payload::text);
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Device', 'Server', 'Deployment', 'Job'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sim_lifecycle_notify ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER sim_lifecycle_notify AFTER INSERT OR UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION sim_lifecycle_notify()', t);
  END LOOP;
END $$;

-- Catch-all: notify {tbl, op, id, deviceId} for EVERY other public table so no
-- change is missed. Handles INSERT/UPDATE/DELETE. The recorder scopes these to
-- the full dump only (the lifecycle tables above drive the per-device view).
CREATE OR REPLACE FUNCTION sim_generic_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE row jsonb := to_jsonb(COALESCE(NEW, OLD));
BEGIN
  PERFORM pg_notify('sim_lifecycle', jsonb_build_object(
    'tbl', TG_TABLE_NAME, 'op', TG_OP, 'id', row->'id', 'deviceId', row->'deviceId')::text);
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('Device', 'Server', 'Deployment', 'Job')
      AND tablename NOT LIKE '\_prisma%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sim_generic_notify ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER sim_generic_notify AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION sim_generic_notify()', t);
  END LOOP;
END $$;

SELECT pg_advisory_unlock(728310042);
