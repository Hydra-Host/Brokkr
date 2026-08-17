-- Drop the dead `monitorPsk` column from Server and Device.
--
-- `monitorPsk` was the monitoring-agent (Zabbix) pre-shared key. Its only
-- consumer was removed on 2026-04-15 (commit 9807d4352 deleted the
-- monitoring-agent install step), and the column was dropped from the legacy
-- DeviceMetadata table at that time. It was then re-introduced onto Device and
-- Server by the netbox port + device_v2 consolidation WITHOUT a consumer, so it
-- has been carrying nothing but a cleartext secret ever since.
--
-- changelog_trigger_func() captures the full row via row_to_json() into the
-- global, untenanted, append-only "Changelog" table, so every write leaked the
-- PSK in cleartext into a long-lived cross-tenant audit trail. Removing the
-- column removes the leak AT THE SOURCE rather than redacting it in the
-- trigger: with the column gone there is nothing for the trigger to capture,
-- and no dead field is left behind.
--
-- The changelog_trigger_func() is intentionally NOT redefined here — with the
-- column gone there is nothing to redact going forward.

-- Drop the dead column. IF EXISTS keeps this safe across any partially-migrated
-- environments.
ALTER TABLE "Server" DROP COLUMN IF EXISTS "monitorPsk";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "monitorPsk";

-- Scrub secrets already captured into historical Changelog rows. The table is
-- append-only, so dropping the column does not remove the values previously
-- leaked into the audit trail — they must be stripped explicitly.
UPDATE "Changelog"
SET "before" = "before" - 'monitorPsk',
    "after"  = "after"  - 'monitorPsk',
    "diff"   = "diff"   - 'monitorPsk'
WHERE "before" ? 'monitorPsk'
   OR "after"  ? 'monitorPsk'
   OR "diff"   ? 'monitorPsk';
