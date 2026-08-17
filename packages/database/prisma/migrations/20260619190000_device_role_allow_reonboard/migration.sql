CREATE OR REPLACE FUNCTION block_device_role_change() RETURNS trigger AS $$
BEGIN
  IF OLD.role IS NOT NULL
     AND NEW.role IS DISTINCT FROM OLD.role
     AND NOT (OLD.role::text = 'Server' AND NEW.role::text = 'DiscoveredHost') THEN
    RAISE EXCEPTION
      'Device.role is write-once: cannot change role of device % from % to % (only the Server->DiscoveredHost re-onboarding transition is permitted). Disable trigger device_role_write_once to override manually.',
      OLD.id, OLD.role, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
