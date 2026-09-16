// Mirrors hub's DhcpAtomSchema (apps/api/src/brokkr-bridge/dhcp/dhcp-atom.schema.ts). Top-level
// .strict() is deliberately omitted so hub-first rolling upgrades don't reject unknown fields.

import { isIPv4 } from 'node:net';

import { z } from 'zod';

import { isRoutableUnicastIpv4 } from '@repo/utils';

import { isValidHostMaskCidr } from '../vrrp/cidr.js';

const ipv4 = z.string().refine(isIPv4, 'must be a valid IPv4 address');
const relayAgentIpv4 = z.string().refine(isRoutableUnicastIpv4, 'must be a routable unicast IPv4 address');

const cidr = z.string().refine(isValidHostMaskCidr, 'must be IPv4 CIDR, e.g. "10.0.1.0/24"');

const mac = z
  .string()
  .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/, 'must be a colon-separated MAC address, e.g. "aa:bb:cc:dd:ee:ff"');

// Matches the DB IpxeBuildTarget enum (uppercase); resolveIpxeTarget() lowercases it downstream.
const ipxeBuildTarget = z.enum(['IPXE', 'SNP', 'SNPONLY']);

export const DhcpAtomValueSchema = z.object({
  mode: z.enum(['AUTHORITATIVE', 'PROXY', 'OFF']),
  subnet: cidr,
  pools: z.array(
    z.object({
      start: ipv4,
      end: ipv4,
    }),
  ),
  routers: z.array(ipv4),
  dnsServers: z.array(ipv4),
  leaseTtlSeconds: z.number().int().min(120).max(0x7fffffff),
  reservations: z.array(
    z.object({
      mac,
      ip: ipv4,
      ipxeBuildTarget: ipxeBuildTarget.nullable().optional(),
      bootFilename: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/)
        .optional(),
    }),
  ),
  dhcpOptions: z.array(
    z.object({
      code: z.number().int().min(1).max(254),
      value: z.string(),
    }),
  ),
  nextServer: ipv4.nullable(),
  ipxeBuildTarget: ipxeBuildTarget.nullable(),
  /** MACs permitted to PXE-boot in PROXY mode; empty array = deny-all (fail-closed). */
  proxyAllowedMacs: z.array(mac).max(65535).default([]),
  // Operator-declared external authoritative DHCP for PROXY mode; absent (older hub) = false.
  proxyPeerAuthoritative: z.boolean().default(false),
  relay: z
    .object({
      relayAgentIp: relayAgentIpv4,
    })
    .nullable(),
});

export type DhcpAtomValue = z.infer<typeof DhcpAtomValueSchema>;

// Mirrors hub's DhcpZoneOpsAtomSchema; zone-global runtime tuning at `config:dhcp`.
export const DhcpZoneOpsAtomValueSchema = z.object({
  leaderPollMs: z.number().int().min(1),
  pruneIntervalMs: z.number().int().min(1),
  declineBackoffSeconds: z.number().int().min(0),
});

export type DhcpZoneOpsAtomValue = z.infer<typeof DhcpZoneOpsAtomValueSchema>;
