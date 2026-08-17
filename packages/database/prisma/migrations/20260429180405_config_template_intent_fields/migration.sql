-- Adds the columns config templates need to render without falling back to
-- NetBox `custom_fields.*`. Decomposed by responsibility:
--   * Device.uefiBoot              — boot mode (separate from secureBootEnabled)
--   * Deployment.cloudInit*, etc. — per-provision autoinstall intent
--   * Zone.proxyGroup, .siteProxyIp — site-wide infra (apt mirror, rsyslog tag)

ALTER TABLE "Device" ADD COLUMN "uefiBoot" BOOLEAN;

ALTER TABLE "Deployment" ADD COLUMN "cloudInitStorageBlock" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "cloudInitNetworkBlock" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "cloudInitLateCommands" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "diskEncryptionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Deployment" ADD COLUMN "gpuDriversEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Zone" ADD COLUMN "proxyGroup" TEXT;
ALTER TABLE "Zone" ADD COLUMN "siteProxyIp" TEXT;
