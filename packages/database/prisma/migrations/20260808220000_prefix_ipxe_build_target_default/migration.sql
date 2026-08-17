-- Materialize the iPXE build-target default: null previously meant "default (IPXE)"
-- in the UI but published null to the bridge, which then injected no boot file.
UPDATE "Prefix" SET "ipxeBuildTarget" = 'IPXE' WHERE "ipxeBuildTarget" IS NULL;

ALTER TABLE "Prefix"
  ALTER COLUMN "ipxeBuildTarget" SET DEFAULT 'IPXE',
  ALTER COLUMN "ipxeBuildTarget" SET NOT NULL;
