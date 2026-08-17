-- Completes step 2 of the lifecycle renaming for the legacy import-compat
-- role: retired devices are now role=Decommissioned. IPAM/rack DEPRECATED
-- statuses (a phase-out state, not platform exit) keep their names.

ALTER TYPE "DeviceRole" RENAME VALUE 'Deprecated' TO 'Decommissioned';
