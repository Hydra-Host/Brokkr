-- Add a per-prefix VRRP floating IP, modeled as a tracked IpAddress FK (mirrors
-- the gateway FK) so the VIP gets IPAM containment/VRF validation and conflict
-- detection. The hub publishes it to the zone's bridges as a Redis atom; the
-- column is nullable (unset = no VIP). SET NULL on delete so removing the linked
-- IP detaches the VIP rather than cascading.

ALTER TABLE "Prefix" ADD COLUMN "vrrpVipId" TEXT;

CREATE INDEX "Prefix_vrrpVipId_idx" ON "Prefix"("vrrpVipId");

ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_vrrpVipId_fkey" FOREIGN KEY ("vrrpVipId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;
