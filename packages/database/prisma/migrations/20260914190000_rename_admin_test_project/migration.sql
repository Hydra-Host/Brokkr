-- The operator test project is resolved by name, so renaming the constant in code
-- orphans every existing row: findOrCreateAdminTestProject would miss them and mint
-- a duplicate, and isBrokkrAdminTestRental would stop recognizing their deployments
-- as internal test rentals. Rename the rows to match.
--
-- Unscoped by org on purpose: internal-rental classification additionally requires
-- the deployment's customer to be the operator org, so a customer project that
-- happens to carry this name cannot gain anything from the rename.
--
-- Orgs where the new code already minted a 'Brokkr Admin Test' row are skipped, so
-- deploying code before this migration cannot leave two same-named rows per org.

UPDATE "DeploymentProject"
SET name = 'Brokkr Admin Test'
WHERE name = 'Hydra Admin Test'
  AND "organizationId" NOT IN (
    SELECT "organizationId"
    FROM "DeploymentProject"
    WHERE name = 'Brokkr Admin Test'
      AND "deletedAt" IS NULL
  );
