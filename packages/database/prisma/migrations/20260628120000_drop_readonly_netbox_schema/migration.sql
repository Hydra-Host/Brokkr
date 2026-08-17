-- The earlier drop (20260617090000) used unqualified DROP TABLE, which under
-- the public search_path only removed the public-schema copies and left the
-- readonly.Netbox* staging tables and the empty `readonly` schema behind. No
-- app code or Prisma model references the `readonly` schema; drop it outright.
-- CASCADE clears the inter-table FKs; no public (Brokkr) table references it.
DROP SCHEMA IF EXISTS "readonly" CASCADE;
