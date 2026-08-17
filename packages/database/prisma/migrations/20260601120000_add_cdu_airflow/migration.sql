-- Adds the required `airflow` direction to the CDU extension table.
--
-- Mirrors NetBox's native device `airflow` choices. The column is NOT NULL
-- so every CDU always carries a direction; the `FrontToRear` default lets
-- existing rows and machine-generated inserts (the device-extension
-- backfill, which writes an FK-only Cdu row) satisfy the constraint without
-- a separate data migration. Operator-facing create flows require an
-- explicit choice at the API/UI layer.

-- CreateEnum
CREATE TYPE "Airflow" AS ENUM ('FrontToRear', 'RearToFront', 'LeftToRight', 'RightToLeft', 'SideToRear', 'Passive', 'Mixed');

-- AlterTable
ALTER TABLE "Cdu" ADD COLUMN     "airflow" "Airflow" NOT NULL DEFAULT 'FrontToRear';
