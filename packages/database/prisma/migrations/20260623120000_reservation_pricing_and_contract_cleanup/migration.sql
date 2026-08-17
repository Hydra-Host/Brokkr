-- Consolidated reservation pricing / contract cleanup.
--
-- Squash of this branch's incremental migrations into one net change:
--   * Reservation GAINS price / billingFrequency / interruptibleNoticePeriod
--     (price backfilled from the 1:1 ContractTerm's buyerPrice).
--   * Reservation LOSES channel / openmeterSubscriptionId / startDate.
--   * ReservationInvite LOSES channel / contractType / supplierPrice / margin;
--     its buyerPrice is renamed to price.
--   * ContractTerm + ContractTermV2 tables are dropped.
--   * ContractType / CollectionMethod / ReservationChannel / ContractTermChannel
--     enum types are dropped.
--
-- contractType and collectionMethod are intentionally never added to Reservation
-- (the incremental sequence added-then-dropped them); the squash skips the
-- round-trip. Interruptibility is now carried by Deployment.isInterruptible and,
-- for reservations, by interruptibleNoticePeriod being non-null.

-- 1. Add the surviving pricing columns to Reservation (all nullable).
ALTER TABLE "Reservation" ADD COLUMN     "price" INTEGER,
ADD COLUMN     "billingFrequency" "BillingFrequency",
ADD COLUMN     "interruptibleNoticePeriod" INTEGER;

-- 2. Backfill from the single ContractTerm per reservation. The relation is
--    one-to-many but 1:1 in practice; a Postgres UPDATE ... FROM with multiple
--    matches silently picks an arbitrary row, so abort if the invariant is
--    ever violated.
DO $$
DECLARE dupes int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT "reservationId" FROM "ContractTerm"
    GROUP BY "reservationId" HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'Backfill aborted: % reservation(s) have multiple ContractTerms; the 1:1 assumption does not hold.', dupes;
  END IF;
END $$;

UPDATE "Reservation" r
SET "price"                     = ct."buyerPrice",
    "billingFrequency"          = ct."billingFrequency",
    "interruptibleNoticePeriod" = ct."interruptibleNoticePeriod"
FROM "ContractTerm" ct
WHERE ct."reservationId" = r.id;

-- 3. Drop the ContractTerm tables. DROP TABLE removes each table's own FK
--    constraints; nothing references them as a target.
DROP TABLE "ContractTerm";
DROP TABLE "ContractTermV2";

-- 4. Drop the removed Reservation / ReservationInvite columns (must precede the
--    DROP TYPE of the enums they reference).
ALTER TABLE "Reservation" DROP COLUMN "channel",
DROP COLUMN "openmeterSubscriptionId",
DROP COLUMN "startDate";

ALTER TABLE "ReservationInvite" DROP COLUMN "channel",
DROP COLUMN "contractType",
DROP COLUMN "supplierPrice",
DROP COLUMN "margin";

-- The invite carries a single buyer-facing price now; supplierPrice / margin
-- are gone (see header). Rename the survivor to match the Prisma model.
ALTER TABLE "ReservationInvite" RENAME COLUMN "buyerPrice" TO "price";

-- 5. Drop the now-orphaned enum types.
DROP TYPE "ContractType";
DROP TYPE "CollectionMethod";
DROP TYPE "ReservationChannel";
DROP TYPE "ContractTermChannel";
