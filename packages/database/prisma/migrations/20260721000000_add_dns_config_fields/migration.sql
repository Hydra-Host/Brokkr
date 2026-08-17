-- Zone-level DNS config fields
ALTER TABLE "Zone" ADD COLUMN "dnsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Zone" ADD COLUMN "dnsUpstreamResolvers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Zone" ADD COLUMN "dnsTtlSeconds" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Zone" ADD COLUMN "dnsCacheSize" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "Zone" ADD COLUMN "dnsOwnedDomain" TEXT NOT NULL DEFAULT 'lan';
ALTER TABLE "Zone" ADD COLUMN "dnsTcpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Zone" ADD COLUMN "dnsTcpMaxConnections" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "dnsTcpMaxQueriesPerConn" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "dnsTcpIdleTimeoutMs" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "dnsTcpMaxMessageBytes" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "dnsMaxTtlSeconds" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "dnsMaxCacheTtlSeconds" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "dnsMinCacheTtlSeconds" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "dnsNegTtlSeconds" INTEGER;

-- Bounded integer constraints: TCP params must be >= 1 when set
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpMaxConnections_positive"
  CHECK ("dnsTcpMaxConnections" IS NULL OR "dnsTcpMaxConnections" >= 1);
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpMaxQueriesPerConn_positive"
  CHECK ("dnsTcpMaxQueriesPerConn" IS NULL OR "dnsTcpMaxQueriesPerConn" >= 1);
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpIdleTimeoutMs_positive"
  CHECK ("dnsTcpIdleTimeoutMs" IS NULL OR "dnsTcpIdleTimeoutMs" >= 1);
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpMaxMessageBytes_positive"
  CHECK ("dnsTcpMaxMessageBytes" IS NULL OR "dnsTcpMaxMessageBytes" >= 1);

-- Non-negative TTL and cache-size constraints
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTtlSeconds_non_negative"
  CHECK ("dnsTtlSeconds" >= 0);
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsCacheSize_non_negative"
  CHECK ("dnsCacheSize" >= 0);

-- dnsOwnedDomain: non-empty, valid hostname pattern (letters, digits, hyphens, dots)
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsOwnedDomain_format"
  CHECK ("dnsOwnedDomain" ~ '^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*$'
    AND length("dnsOwnedDomain") <= 253);

-- Cache TTL ordering: min <= max when both are set
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dns_cache_ttl_ordering"
  CHECK ("dnsMinCacheTtlSeconds" IS NULL OR "dnsMaxCacheTtlSeconds" IS NULL
    OR "dnsMinCacheTtlSeconds" <= "dnsMaxCacheTtlSeconds");

-- Per-prefix DNS override fields
ALTER TABLE "Prefix" ADD COLUMN "dnsServeDns" BOOLEAN;
ALTER TABLE "Prefix" ADD COLUMN "dnsUpstreamOverride" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A prefix with any DNS override must belong to a zone (the DNS atom is zone-scoped);
-- mirrors Prefix_dhcp_requires_zone_check.
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dns_override_requires_zone_check"
  CHECK (
    ("dnsServeDns" IS NULL AND "dnsUpstreamOverride" = ARRAY[]::TEXT[])
    OR "zoneId" IS NOT NULL
  );
