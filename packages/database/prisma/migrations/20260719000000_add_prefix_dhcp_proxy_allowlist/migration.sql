-- AlterTable: operator-added PROXY-mode PXE MAC allowlist (on top of auto-derived known devices)
ALTER TABLE "Prefix" ADD COLUMN "dhcpProxyAllowedMacs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
