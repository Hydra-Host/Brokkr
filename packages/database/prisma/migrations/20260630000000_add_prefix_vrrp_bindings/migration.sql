-- Per-bridge VRRP VIP iface binding. Replaces the single zone-wide
-- Prefix.vrrpVipIface string: a zone's bridges can name the VIP-facing NIC
-- differently, so the iface is chosen per bridge (Device with role=Bridge). The
-- hub folds these rows into the per-prefix atom as an ifaceByBridge map keyed by
-- Device.name; a bridge absent from the map never binds the VIP.

CREATE TABLE "PrefixVrrpBinding" (
    "id" TEXT NOT NULL,
    "prefixId" TEXT NOT NULL,
    "bridgeId" TEXT NOT NULL,
    "iface" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrefixVrrpBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PrefixVrrpBinding_prefixId_bridgeId_key" ON "PrefixVrrpBinding"("prefixId", "bridgeId");

CREATE INDEX "PrefixVrrpBinding_bridgeId_idx" ON "PrefixVrrpBinding"("bridgeId");

ALTER TABLE "PrefixVrrpBinding" ADD CONSTRAINT "PrefixVrrpBinding_prefixId_fkey" FOREIGN KEY ("prefixId") REFERENCES "Prefix"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrefixVrrpBinding" ADD CONSTRAINT "PrefixVrrpBinding_bridgeId_fkey" FOREIGN KEY ("bridgeId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
