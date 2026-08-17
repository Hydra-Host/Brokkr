-- Generalize ZoneContact into a unified Contact that serves zones, supplier
-- organizations, AND hardware manufacturers (OEM). Exactly one of
-- zoneId / organizationId / manufacturerId is set — enforced in the service and
-- by the Contact_exactly_one_parent CHECK below. title/phone/contactType relax
-- to nullable so org/manufacturer contacts can omit them; support-channel fields
-- and editable ContactTag role tags are added.

-- Rename ZoneContact -> Contact (data-preserving: table, pkey, zone index + FK).
ALTER TABLE "ZoneContact" RENAME TO "Contact";
ALTER INDEX "ZoneContact_pkey" RENAME TO "Contact_pkey";
ALTER INDEX "ZoneContact_zoneId_idx" RENAME TO "Contact_zoneId_idx";
ALTER TABLE "Contact" RENAME CONSTRAINT "ZoneContact_zoneId_fkey" TO "Contact_zoneId_fkey";

-- Relax previously-required columns + add org/manufacturer parents and support channels.
ALTER TABLE "Contact"
  ALTER COLUMN "title" DROP NOT NULL,
  ALTER COLUMN "phone" DROP NOT NULL,
  ALTER COLUMN "contactType" DROP NOT NULL,
  ALTER COLUMN "zoneId" DROP NOT NULL,
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "manufacturerId" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "slackLink" TEXT,
  ADD COLUMN "ticketingPortalUrl" TEXT,
  ADD COLUMN "website" TEXT;

CREATE INDEX "Contact_organizationId_idx" ON "Contact"("organizationId");
CREATE INDEX "Contact_manufacturerId_idx" ON "Contact"("manufacturerId");

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_manufacturerId_fkey"
  FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one parent (zone / organization / manufacturer). Prisma can't express
-- a cross-column CHECK, so it's raw SQL; the service enforces the same rule.
ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_exactly_one_parent"
  CHECK (num_nonnulls("zoneId", "organizationId", "manufacturerId") = 1);

-- Editable role tags for contacts.
CREATE TABLE "ContactTag" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "group" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactTag_label_key" ON "ContactTag"("label");

-- Implicit many-to-many join (Prisma `Contact.tags` <-> `ContactTag.contacts`).
-- Prisma orders the relation sides alphabetically: A = Contact, B = ContactTag.
CREATE TABLE "_ContactToContactTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ContactToContactTag_AB_pkey" PRIMARY KEY ("A", "B")
);

CREATE INDEX "_ContactToContactTag_B_index" ON "_ContactToContactTag"("B");

ALTER TABLE "_ContactToContactTag"
  ADD CONSTRAINT "_ContactToContactTag_A_fkey"
  FOREIGN KEY ("A") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_ContactToContactTag"
  ADD CONSTRAINT "_ContactToContactTag_B_fkey"
  FOREIGN KEY ("B") REFERENCES "ContactTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the suggested tag taxonomy (editable afterwards).
INSERT INTO "ContactTag" ("id", "label", "group", "updatedAt") VALUES
  (gen_random_uuid(), 'Main', 'General', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Technical', 'General', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Financial', 'General', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Shipping', 'General', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'OEM – Account Manager', 'OEM', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'OEM – Support', 'OEM', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Internet Upstream', 'Connectivity', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Local WAN', 'Connectivity', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Integrator', 'Site', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Procurement', 'Site', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Facility Operator', 'Site', CURRENT_TIMESTAMP);
