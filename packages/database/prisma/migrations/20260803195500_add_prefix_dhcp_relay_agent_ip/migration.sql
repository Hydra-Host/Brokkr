ALTER TABLE "Prefix" ADD COLUMN "dhcpRelayAgentIp" INET;

ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcpRelayAgentIp_ipv4_check"
  CHECK ("dhcpRelayAgentIp" IS NULL OR family("dhcpRelayAgentIp") = 4);

ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcpRelayAgentIp_unicast_check"
  CHECK (
    "dhcpRelayAgentIp" IS NULL
    OR (
      "dhcpRelayAgentIp" <> '0.0.0.0'::inet
      AND NOT "dhcpRelayAgentIp" <<= '127.0.0.0/8'::inet
      AND NOT "dhcpRelayAgentIp" <<= '169.254.0.0/16'::inet
      -- 224.0.0.0/3 = multicast (224/4) + Class E reserved (240/4, incl. broadcast)
      AND NOT "dhcpRelayAgentIp" <<= '224.0.0.0/3'::inet
    )
  );

ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_active_relay_requires_agent_ip_check"
  CHECK (
    "status" IS DISTINCT FROM 'ACTIVE'
    OR "dhcpMode" IS NULL
    OR "dhcpMode" = 'OFF'
    OR "associatedPrefixId" IS NULL
    OR "dhcpRelayAgentIp" IS NOT NULL
  );

CREATE UNIQUE INDEX "Prefix_zone_dhcpRelayAgentIp_enabled_key"
  ON "Prefix"("zoneId", "dhcpRelayAgentIp")
  WHERE "deletedAt" IS NULL
    AND "dhcpMode" IS NOT NULL
    AND "dhcpMode" <> 'OFF'
    AND "dhcpRelayAgentIp" IS NOT NULL;
