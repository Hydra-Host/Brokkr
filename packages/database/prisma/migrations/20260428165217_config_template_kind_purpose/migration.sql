-- Adds dispatch + purpose markers to ConfigTemplate so the Jinja renderer
-- knows which context builder to invoke and the admin preview can look up
-- the active template by role.

CREATE TYPE "ConfigTemplateKind" AS ENUM ('DEVICE_INFRASTRUCTURE');
CREATE TYPE "ConfigTemplatePurpose" AS ENUM ('NETPLAN');

ALTER TABLE "ConfigTemplate"
  ADD COLUMN "kind" "ConfigTemplateKind" NOT NULL DEFAULT 'DEVICE_INFRASTRUCTURE',
  ADD COLUMN "purpose" "ConfigTemplatePurpose";

CREATE UNIQUE INDEX "ConfigTemplate_purpose_key" ON "ConfigTemplate"("purpose");
