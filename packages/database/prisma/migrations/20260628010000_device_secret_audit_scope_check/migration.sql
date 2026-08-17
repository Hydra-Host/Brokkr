-- Disclosure-audit invariant: every DeviceSecretAuditEvent is scoped to a device OR a zone. Since the
-- ephemeral migration (20260626130000) made deviceId nullable and added a nullable zoneId, the schema
-- alone allows both to be null — an orphaned audit row that records a disclosure against nothing. Prisma
-- can't model CHECK constraints, so this raw migration owns the rule; the service also guards it in code.

-- AddConstraint
ALTER TABLE "DeviceSecretAuditEvent"
  ADD CONSTRAINT "DeviceSecretAuditEvent_device_or_zone_scope"
  CHECK ("deviceId" IS NOT NULL OR "zoneId" IS NOT NULL);
