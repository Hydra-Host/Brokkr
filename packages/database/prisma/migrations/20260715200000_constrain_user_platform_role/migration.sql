DO $$
DECLARE
  invalid_roles text;
BEGIN
  SELECT string_agg(DISTINCT role, ', ' ORDER BY role)
  INTO invalid_roles
  FROM "User"
  WHERE role NOT IN ('user', 'admin');

  IF invalid_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'Unsupported User.role values require an explicit backfill before this migration can continue: %',
      invalid_roles;
  END IF;
END
$$;

ALTER TABLE "User"
ADD CONSTRAINT "User_role_supported_check"
CHECK (role IN ('user', 'admin'));
