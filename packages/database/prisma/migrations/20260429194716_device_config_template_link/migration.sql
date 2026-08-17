-- Adds nullable Device.configTemplateId FK so each device can opt into a
-- specific ConfigTemplate (mirrors NetBox device.config_template). Null
-- means "fall back to the purpose-tagged default" at render time.

ALTER TABLE "Device" ADD COLUMN "configTemplateId" TEXT;

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_configTemplateId_fkey"
  FOREIGN KEY ("configTemplateId") REFERENCES "ConfigTemplate"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Device_configTemplateId_idx" ON "Device"("configTemplateId");
