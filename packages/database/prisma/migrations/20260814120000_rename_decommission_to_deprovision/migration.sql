-- Rename the rental-end lifecycle term from "decommission" to "deprovision".
-- "Decommission" is being freed up to later replace "deprecate" (platform exit).
-- Circuit/BGP/cable DCIM statuses keep their NetBox-convention names.

ALTER TYPE "ServerLifecycleStatus" RENAME VALUE 'DECOMMISSIONING' TO 'DEPROVISIONING';
ALTER TYPE "JobType" RENAME VALUE 'Decommission' TO 'Deprovision';
ALTER TYPE "AdminLifecycleRequestType" RENAME VALUE 'DECOMMISSION' TO 'DEPROVISION';
ALTER TYPE "DeploymentLifecycleActionType" RENAME VALUE 'Decommission' TO 'Deprovision';
