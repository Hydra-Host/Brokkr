-- Device.role is write-once.
--
-- A device's role may be assigned exactly once, while it is unassigned
-- (role IS NULL). Once role is non-null — a canonical role (Server/Bridge/
-- Switch/Router/PDU/CDU) or a legacy NetBox-era value — it can never be
-- changed programmatically: not to a different role, and not back to null.
--
-- This is enforced at the DB so it holds across EVERY programmatic path
-- (the admin API, the NetBox backfill, kafka-sync, future code). There is
-- intentionally no application-level escape hatch. The only way to change a
-- set role is a manual, deliberate DB edit with the trigger disabled:
--
--   ALTER TABLE "Device" DISABLE TRIGGER device_role_write_once;
--   UPDATE "Device" SET role = '...' WHERE id = '...';
--   ALTER TABLE "Device" ENABLE TRIGGER device_role_write_once;
--
-- An UPDATE that leaves role unchanged (NEW.role = OLD.role) always passes,
-- so ordinary edits to other columns are unaffected.

CREATE OR REPLACE FUNCTION block_device_role_change() RETURNS trigger AS $$
BEGIN
  IF OLD.role IS NOT NULL AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION
      'Device.role is write-once: cannot change role of device % from % to % (a role may only be assigned while unassigned). Disable trigger device_role_write_once to override manually.',
      OLD.id, OLD.role, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER device_role_write_once
  BEFORE UPDATE ON "Device"
  FOR EACH ROW
  EXECUTE FUNCTION block_device_role_change();
