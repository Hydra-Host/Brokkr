// Validator semantics — the remote_write SSRF egress guard and the "either ip or device_id" validators — are security-load-bearing; error message tokens are wire-checked.

import { isIP } from 'node:net';

import { z } from 'zod';

export function rejectPathTraversal(value: string, fieldName: string): string | null {
  if (value.includes('..') || value.toLowerCase().includes('%2e')) {
    return `Path traversal sequences are not allowed in ${fieldName}`;
  }
  return null;
}

function regexToJs(pattern: string): string {
  let out = pattern.replace(/\(\?P</g, '(?<').replace(/\(\?P=([^)]+)\)/g, '\\k<$1>');
  out = out.replace(/\(\?#[^)]*\)/g, '');
  out = out.replace(/\(\?[aiLmsux]+\)/g, '');
  out = out.replace(/\(\?>/g, '(?:');
  out = out.replace(/(\*|\+|\?|\})\+/g, '$1');
  return out;
}

export function validateRegexPattern(pattern: string): string | null {
  if (pattern.length > 200) {
    return `Regex pattern too long (${pattern.length} chars, max 200)`;
  }
  try {
    new RegExp(regexToJs(pattern));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid regex pattern '${pattern}': ${message}`;
  }
  return null;
}

function ipv4OctetsToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = result * 256 + n;
  }
  return result;
}

const IPV4_BLOCKED_EXCEPTIONS = new Set(['192.0.0.9', '192.0.0.10']);

function ipv4IsBlocked(ip: string): boolean {
  if (IPV4_BLOCKED_EXCEPTIONS.has(ip)) return false;
  const n = ipv4OctetsToNumber(ip);
  if (n === null) return false;
  const inRange = (start: string, end: string) => {
    const s = ipv4OctetsToNumber(start)!;
    const e = ipv4OctetsToNumber(end)!;
    return n >= s && n <= e;
  };
  if (inRange('127.0.0.0', '127.255.255.255')) return true;
  if (inRange('10.0.0.0', '10.255.255.255')) return true;
  if (inRange('172.16.0.0', '172.31.255.255')) return true;
  if (inRange('192.168.0.0', '192.168.255.255')) return true;
  if (inRange('169.254.0.0', '169.254.255.255')) return true;
  if (inRange('0.0.0.0', '0.255.255.255')) return true;
  if (inRange('192.0.0.0', '192.0.0.255')) return true;
  if (inRange('192.0.2.0', '192.0.2.255')) return true;
  if (inRange('198.18.0.0', '198.19.255.255')) return true;
  if (inRange('198.51.100.0', '198.51.100.255')) return true;
  if (inRange('203.0.113.0', '203.0.113.255')) return true;
  if (inRange('240.0.0.0', '255.255.255.255')) return true;
  return false;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const lower = ip.toLowerCase();
  const parts = lower.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];

  const lastRight = right[right.length - 1];
  if (lastRight !== undefined && lastRight.includes('.')) {
    const v4 = lastRight.split('.');
    if (v4.length !== 4) return null;
    const nums = v4.map((s) => Number(s));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    right.pop();
    right.push(((nums[0] << 8) | nums[1]).toString(16));
    right.push(((nums[2] << 8) | nums[3]).toString(16));
  }

  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  if (missing > 0 && parts.length !== 2) return null;
  if (missing === 0 && parts.length === 2) return null;

  const hextets = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (hextets.length !== 8) return null;

  let result = 0n;
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    result = (result << 16n) | BigInt(parseInt(h, 16));
  }
  return result;
}

function ipv6InNetwork(addr: bigint, network: bigint, prefixLen: number): boolean {
  if (prefixLen === 0) return true;
  const mask = ((1n << BigInt(prefixLen)) - 1n) << BigInt(128 - prefixLen);
  return (addr & mask) === (network & mask);
}

const IPV6_BLOCKED_NETWORKS: ReadonlyArray<readonly [bigint, number]> = [
  [0x00000000000000000000000000000000n, 8],
  [0x01000000000000000000000000000000n, 8],
  [0x02000000000000000000000000000000n, 7],
  [0x04000000000000000000000000000000n, 6],
  [0x08000000000000000000000000000000n, 5],
  [0x10000000000000000000000000000000n, 4],
  [0x20010000000000000000000000000000n, 23],
  [0x20010db8000000000000000000000000n, 32],
  [0x20020000000000000000000000000000n, 16],
  [0x3fff0000000000000000000000000000n, 20],
  [0x40000000000000000000000000000000n, 3],
  [0x60000000000000000000000000000000n, 3],
  [0x80000000000000000000000000000000n, 3],
  [0xa0000000000000000000000000000000n, 3],
  [0xc0000000000000000000000000000000n, 3],
  [0xe0000000000000000000000000000000n, 4],
  [0xf0000000000000000000000000000000n, 5],
  [0xf8000000000000000000000000000000n, 6],
  [0xfc000000000000000000000000000000n, 7],
  [0xfe000000000000000000000000000000n, 9],
  [0xfe800000000000000000000000000000n, 10],
];

const IPV6_BLOCKED_EXCEPTIONS: ReadonlyArray<readonly [bigint, number]> = [
  [0x20010001000000000000000000000001n, 128],
  [0x20010001000000000000000000000002n, 128],
  [0x20010003000000000000000000000000n, 32],
  [0x20010004011200000000000000000000n, 48],
  [0x20010020000000000000000000000000n, 28],
  [0x20010030000000000000000000000000n, 28],
];

function ipv6IsBlocked(ip: string): boolean {
  const lower = ip.toLowerCase();
  const addr = ipv6ToBigInt(lower);
  if (addr === null) return false;
  if (addr >> 32n === 0xffffn) {
    const v4 = Number(addr & 0xffffffffn);
    const dotted = `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`;
    return ipv4IsBlocked(dotted);
  }
  if (IPV6_BLOCKED_EXCEPTIONS.some(([net, plen]) => ipv6InNetwork(addr, net, plen))) return false;
  return IPV6_BLOCKED_NETWORKS.some(([net, plen]) => ipv6InNetwork(addr, net, plen));
}

interface UrlParts {
  scheme: string;
  hostname: string | null;
  path: string;
}

// Must NOT throw on inputs like 'http://' so the SSRF validator can emit a structured error.
function urlParseLite(value: string): UrlParts {
  let rest = value;
  let scheme = '';
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = schemeMatch[2];
  }
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) rest = rest.slice(0, hashIdx);
  const qIdx = rest.indexOf('?');
  if (qIdx >= 0) rest = rest.slice(0, qIdx);

  let netloc = '';
  let path = rest;
  if (rest.startsWith('//')) {
    const afterSlashes = rest.slice(2);
    const pathIdx = afterSlashes.search(/[/]/);
    if (pathIdx >= 0) {
      netloc = afterSlashes.slice(0, pathIdx);
      path = afterSlashes.slice(pathIdx);
    } else {
      netloc = afterSlashes;
      path = '';
    }
  }

  const atIdx = netloc.lastIndexOf('@');
  if (atIdx >= 0) netloc = netloc.slice(atIdx + 1);

  let host: string | null = null;
  if (netloc.startsWith('[')) {
    const close = netloc.indexOf(']');
    if (close > 0) host = netloc.slice(1, close);
  } else if (netloc.length > 0) {
    const colon = netloc.indexOf(':');
    host = colon >= 0 ? netloc.slice(0, colon) : netloc;
  }
  if (host !== null) {
    host = host.length === 0 ? null : host.toLowerCase();
  }
  return { scheme, hostname: host, path };
}

function validateRemoteWriteUrl(value: string): string | null {
  const parsed = urlParseLite(value);
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    return 'remote_write_url must use http or https scheme';
  }
  if (!parsed.hostname) {
    return 'remote_write_url must include a hostname';
  }
  const host = parsed.hostname;
  const blockedHosts = ['localhost', 'metadata.google', 'metadata.aws'];
  for (const b of blockedHosts) {
    if (host === b || host.startsWith(`${b}.`)) {
      return 'remote_write_url must not target localhost or cloud metadata endpoints';
    }
  }
  const ipFamily = isIP(host);
  if (ipFamily === 4) {
    if (ipv4IsBlocked(host)) {
      return 'remote_write_url must not target loopback, private, link-local, or reserved IP addresses';
    }
  } else if (ipFamily === 6) {
    const pctIdx = host.indexOf('%');
    const bare = pctIdx >= 0 ? host.slice(0, pctIdx) : host;
    if (ipv6IsBlocked(bare)) {
      return 'remote_write_url must not target loopback, private, link-local, or reserved IP addresses';
    }
  }
  if (!parsed.path || parsed.path === '/') {
    return 'remote_write_url must include a path (e.g. /api/v1/receive)';
  }
  return null;
}

export const pingRequestSchema = z
  .object({
    ip: z.string().nullish(),
    device_id: z.string().nullish(),
    count: z.number().int().default(5),
    timeout: z.number().int().default(3),
    packet_size: z.number().int().default(56),
    interval: z.number().int().default(1000),
    extended_metrics: z.boolean().default(false),
  })
  .transform((value) => {
    const ip = value.ip != null ? value.ip.trim() || null : value.ip;
    const device_id = value.device_id != null ? value.device_id.trim() || null : value.device_id;
    return { ...value, ip, device_id };
  })
  .superRefine((value, ctx) => {
    if (!value.ip && !value.device_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "either 'ip' or 'device_id' is required",
      });
    }
  });

export type PingRequest = z.infer<typeof pingRequestSchema>;

export const pingBatchRequestSchema = z.object({
  targets: z.array(z.record(z.unknown())),
  default_count: z.number().int().default(5),
  default_timeout: z.number().int().default(3),
  default_packet_size: z.number().int().default(56),
});

export type PingBatchRequest = z.infer<typeof pingBatchRequestSchema>;

export const ipmiMetricsRequestSchema = z
  .object({
    ip: z.string().nullish(),
    username: z.string().nullish(),
    password: z.string().nullish(),
    device_id: z.string().nullish(),
    command: z.unknown().refine((v) => v !== undefined, { message: 'Field required' }),
    port: z.number().int().default(623),
  })
  .superRefine((value, ctx) => {
    const hasCreds = Boolean(value.ip && value.username && value.password);
    if (!hasCreds && !value.device_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "either 'device_id' or all of 'ip'/'username'/'password' are required",
      });
    }
  });

export type IpmiMetricsRequest = z.infer<typeof ipmiMetricsRequestSchema>;

export const ipmiBatchMetricsRequestSchema = z.object({
  ip: z.string(),
  username: z.string(),
  password: z.string(),
  commands: z.array(z.unknown()),
  port: z.number().int().default(623),
});

export type IpmiBatchMetricsRequest = z.infer<typeof ipmiBatchMetricsRequestSchema>;

export const pingMetricsSchema = z.preprocess(
  (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const r = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...r };
    if (r['icmppingsec.min'] !== undefined) out.icmppingsec_min = r['icmppingsec.min'];
    if (r['icmppingsec.max'] !== undefined) out.icmppingsec_max = r['icmppingsec.max'];
    if (r['icmppingsec.avg'] !== undefined) out.icmppingsec_avg = r['icmppingsec.avg'];
    delete out['icmppingsec.min'];
    delete out['icmppingsec.max'];
    delete out['icmppingsec.avg'];
    return out;
  },
  z.object({
    icmpping: z.number().int(),
    icmppingloss: z.number(),
    icmppingsec: z.number().nullish(),
    icmppingsec_min: z.number().nullish(),
    icmppingsec_max: z.number().nullish(),
    icmppingsec_avg: z.number().nullish(),
    packets_sent: z.number().int().optional(),
    packets_received: z.number().int().optional(),
    rtt_mdev_ms: z.number().nullish(),
    jitter_ms: z.number().nullish(),
  }),
);

export type PingMetrics = z.infer<typeof pingMetricsSchema>;

export const pingResponseSchema = z.object({
  result: z.enum(['success', 'failure']),
  target_ip: z.string(),
  metrics: pingMetricsSchema.nullish(),
  error: z.string().nullish(),
});

export type PingResponse = z.infer<typeof pingResponseSchema>;

export const pingBatchResponseSchema = z.object({
  total_targets: z.number().int(),
  successful: z.number().int(),
  failed: z.number().int(),
  results: z.array(z.record(z.unknown())),
});

export type PingBatchResponse = z.infer<typeof pingBatchResponseSchema>;

export const ipmiMetricsResponseSchema = z.object({
  result: z.enum(['success', 'failure']),
  response: z.string(),
  command: z.array(z.string()).nullish(),
  target_ip: z.string().nullish(),
  cipher_used: z.number().int().nullish(),
});

export type IpmiMetricsResponse = z.infer<typeof ipmiMetricsResponseSchema>;

export const ipmiBatchMetricsResponseSchema = z.object({
  target_ip: z.string(),
  total_commands: z.number().int(),
  successful: z.number().int(),
  failed: z.number().int(),
  results: z.array(z.record(z.unknown())),
  cipher_used: z.number().int().nullish(),
});

export type IpmiBatchMetricsResponse = z.infer<typeof ipmiBatchMetricsResponseSchema>;

const snmpVersionEnum = z.enum(['1', '2c', '3']);
const snmpSecurityLevelEnum = z.enum(['noAuthNoPriv', 'authNoPriv', 'authPriv']);
const snmpAuthProtocolEnum = z.enum(['MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512']);
const snmpPrivProtocolEnum = z.enum(['DES', 'AES128', 'AES256']);

export const snmpGetRequestSchema = z.object({
  target: z.string(),
  port: z.number().int().default(161),
  version: snmpVersionEnum.default('3'),
  oids: z.array(z.string()).min(1),
  community: z.string().nullish(),
  username: z.string().nullish(),
  security_level: snmpSecurityLevelEnum.default('authPriv'),
  auth_protocol: snmpAuthProtocolEnum.nullish(),
  auth_passphrase: z.string().nullish(),
  priv_protocol: snmpPrivProtocolEnum.nullish(),
  priv_passphrase: z.string().nullish(),
  job_id: z.string().nullish(),
});

export type SnmpGetRequest = z.infer<typeof snmpGetRequestSchema>;

export const snmpWalkRequestSchema = z.object({
  target: z.string(),
  port: z.number().int().default(161),
  version: snmpVersionEnum.default('3'),
  oid: z.string(),
  max_results: z.number().int().min(1).default(500),
  community: z.string().nullish(),
  username: z.string().nullish(),
  security_level: snmpSecurityLevelEnum.default('authPriv'),
  auth_protocol: snmpAuthProtocolEnum.nullish(),
  auth_passphrase: z.string().nullish(),
  priv_protocol: snmpPrivProtocolEnum.nullish(),
  priv_passphrase: z.string().nullish(),
  job_id: z.string().nullish(),
});

export type SnmpWalkRequest = z.infer<typeof snmpWalkRequestSchema>;

export const snmpVarbindSchema = z.object({
  oid: z.string(),
  type: z.string(),
  value: z.preprocess((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v), z.union([z.number().int(), z.string()])),
});

export type SnmpVarbind = z.infer<typeof snmpVarbindSchema>;

export const snmpResponseSchema = z.object({
  result: z.enum(['success', 'partial', 'failure']),
  target: z.string(),
  data: z.array(snmpVarbindSchema).nullish(),
  error: z.string().nullish(),
  truncated: z.boolean().nullish(),
  truncation_reason: z.string().nullish(),
});

export type SnmpResponse = z.infer<typeof snmpResponseSchema>;

const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const redfishEndpointPattern = /^\/redfish\/v1\//;

export const redfishMetricsRequestSchema = z
  .object({
    bmc_ip: z.string().regex(ipv4Pattern).nullish(),
    device_id: z.string().nullish(),
    endpoint: z
      .string()
      .regex(redfishEndpointPattern)
      .superRefine((value, ctx) => {
        const err = rejectPathTraversal(value, 'endpoint');
        if (err) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
        }
      }),
    method: z.literal('GET').default('GET'),
    username: z.string().nullish(),
    password: z.string().nullish(),
    port: z.number().int().default(443),
    protocol: z.enum(['https', 'http']).default('https'),
    headers: z.string().nullish(),
    job_id: z.string().nullish(),
  })
  .superRefine((value, ctx) => {
    const hasCreds = Boolean(value.bmc_ip && value.username && value.password);
    if (!hasCreds && !value.device_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "either 'device_id' or all of 'bmc_ip'/'username'/'password' are required",
      });
    }
  });

export type RedfishMetricsRequest = z.infer<typeof redfishMetricsRequestSchema>;

export const redfishMetricsResponseSchema = z.record(z.unknown());

export type RedfishMetricsResponse = z.infer<typeof redfishMetricsResponseSchema>;

export const deviceSensorsRequestSchema = z.object({
  device_id: z.string(),
  kind: z.enum(['server', 'cdu']).default('server'),
  job_id: z.string().nullish(),
});

export type DeviceSensorsRequest = z.infer<typeof deviceSensorsRequestSchema>;

export const deviceSensorsResponseSchema = z.record(z.unknown());

export type DeviceSensorsResponse = z.infer<typeof deviceSensorsResponseSchema>;

export const prometheusMetricsRequestSchema = z.object({
  target_ip: z.string().regex(ipv4Pattern),
  port: z.number().int().min(1).max(65535).default(9100),
  metrics_path: z
    .string()
    .default('/metrics')
    .superRefine((value, ctx) => {
      const err = rejectPathTraversal(value, 'metrics_path');
      if (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
        return;
      }
      if (!value.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'metrics_path must start with /',
        });
      }
    }),
  protocol: z.enum(['http', 'https']).default('http'),
  timeout: z.number().int().min(1).max(300).default(15),
  job_id: z.string().nullish(),
  remote_write_url: z
    .string()
    .nullish()
    .superRefine((value, ctx) => {
      if (value == null) return;
      const err = validateRemoteWriteUrl(value);
      if (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
      }
    }),
  remote_write_username: z.string().nullish(),
  remote_write_password: z.string().nullish(),
  host_name: z.string().nullish(),
  metric_include: z
    .array(z.string())
    .nullish()
    .superRefine((value, ctx) => {
      if (value == null) return;
      for (const pattern of value) {
        const err = validateRegexPattern(pattern);
        if (err) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
          return;
        }
      }
    }),
  metric_exclude: z
    .array(z.string())
    .nullish()
    .superRefine((value, ctx) => {
      if (value == null) return;
      for (const pattern of value) {
        const err = validateRegexPattern(pattern);
        if (err) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
          return;
        }
      }
    }),
  filter_metric: z.string().nullish(),
  filter_value: z.preprocess((v) => (v == null ? v : Number(v)), z.union([z.number(), z.nan()]).nullish()),
  filter_labels: z.array(z.string()).nullish(),
});

export type PrometheusMetricsRequest = z.infer<typeof prometheusMetricsRequestSchema>;
