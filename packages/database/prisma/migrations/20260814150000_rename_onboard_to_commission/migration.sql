-- Step 3 of the lifecycle renaming: platform entry is "commission"
-- (commission -> provision -> deprovision -> decommission).

ALTER TYPE "JobType" RENAME VALUE 'Onboard' TO 'Commission';
