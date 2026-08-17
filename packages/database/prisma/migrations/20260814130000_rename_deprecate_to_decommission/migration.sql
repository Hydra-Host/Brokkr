-- Rename the platform-exit term from "deprecate" to "decommission"
-- (step 2 of the lifecycle renaming; step 1 freed the name by renaming
-- rental-end "decommission" to "deprovision").
-- NetBox-convention statuses (ipam/rack DEPRECATED) and the legacy
-- DeviceRole.Deprecated import-compat value keep their names.

ALTER TYPE "JobType" RENAME VALUE 'Deprecate' TO 'Decommission';
ALTER TYPE "WebhookEventType" RENAME VALUE 'DEVICE_LISTING_DEPRECATED' TO 'DEVICE_LISTING_DECOMMISSIONED';
