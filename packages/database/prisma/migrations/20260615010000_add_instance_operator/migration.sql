-- Operator designation: mark which Organization is the instance operator,
-- the gate for operator-only capabilities (see OperatorPolicy). The partial
-- unique index permits any number of `false` rows but only a single `true`,
-- enforcing the at-most-one-operator singleton at the database level.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "isInstanceOperator" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_isInstanceOperator_key" ON "Organization" ("isInstanceOperator") WHERE "isInstanceOperator";
