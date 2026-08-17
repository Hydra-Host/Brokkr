import { Inject, Injectable, Optional } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getErrorMessage } from '../../common/error-utils';

import { ContextLogger } from '../../logger/logger.service';

import { Label, Sample, TimeSeries, WriteRequest } from './protobuf-utils';

export class PrometheusMonitoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrometheusMonitoringError';
  }
}

export interface PrometheusMonitoringLogger {
  debug(message: string, context?: { jobId?: string }): Promise<void>;
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

export const PROMETHEUS_LOGGER = Symbol('PROMETHEUS_LOGGER');
export const PROMETHEUS_FETCH = Symbol('PROMETHEUS_FETCH');
export const PROMETHEUS_SNAPPY = Symbol('PROMETHEUS_SNAPPY');
export const PROMETHEUS_DNS_LOOKUP = Symbol('PROMETHEUS_DNS_LOOKUP');

export interface PrometheusScrapeOptions {
  targetIp: string;
  port: number;
  metricsPath: string;
  protocol?: string;
  timeout?: number;
}

export interface PrometheusParsedSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface PrometheusParseOptions {
  extraLabels?: Record<string, string>;
  metricInclude?: string[];
  metricExclude?: string[];
  filterMetric?: string;
  filterValue?: number | null;
  filterLabels?: string[];
}

export interface PrometheusScrapeAndPushOptions {
  targetIp: string;
  port: number;
  metricsPath: string;
  protocol: string;
  timeout: number;
  remoteWriteUrl: string;
  remoteWriteUsername?: string | null;
  remoteWritePassword?: string | null;
  hostName?: string | null;
  metricInclude?: string[];
  metricExclude?: string[];
  filterMetric?: string;
  filterValue?: number | null;
  filterLabels?: string[];
}

export interface PrometheusPushResult {
  result: 'success' | 'partial' | 'failure';
  metrics_pushed: number;
  metrics_failed?: number;
  error?: string;
  host_name: string;
}

export interface PrometheusFetcher {
  get(url: string, timeoutSeconds: number): Promise<{ status: number; text: () => Promise<string> }>;
  post(
    url: string,
    body: Uint8Array,
    headers: Record<string, string>,
    timeoutSeconds: number,
  ): Promise<{ status: number; text: () => Promise<string> }>;
}

export interface SnappyCompressor {
  compress(input: Uint8Array): Uint8Array;
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const DEFAULT_DNS_LOOKUP: DnsLookup = async (hostname) => {
  return dnsLookup(hostname, { all: true });
};

const METRIC_LINE_RE =
  /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?<labels>[^}]*)\})?\s+(?<value>\S+)(?:\s+(?<timestamp>\d+))?$/;

const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

const BATCH_SIZE = 5000;

function parseFloatStrict(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'nan' || lower === '+nan' || lower === '-nan') return NaN;
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') return Infinity;
  if (lower === '-inf' || lower === '-infinity') return -Infinity;
  const n = Number(trimmed);
  if (Number.isNaN(n)) return null;
  return n;
}

function tryCompileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function fullMatch(re: RegExp, value: string): boolean {
  const m = value.match(re);
  if (!m) return false;
  return m[0] === value && m.index === 0;
}

export function parsePrometheusText(text: string, options: PrometheusParseOptions = {}): PrometheusParsedSeries[] {
  const extraLabels = options.extraLabels ?? {};

  const includeRes: RegExp[] = [];
  for (const p of options.metricInclude ?? []) {
    const re = tryCompileRegex(p);
    if (re) includeRes.push(re);
  }
  const excludeRes: RegExp[] = [];
  for (const p of options.metricExclude ?? []) {
    const re = tryCompileRegex(p);
    if (re) excludeRes.push(re);
  }

  const filterMetric = options.filterMetric;
  const filterValue = options.filterValue;
  const filterLabels = options.filterLabels;
  const useFilter = Boolean(
    filterMetric && filterValue !== null && filterValue !== undefined && filterLabels && filterLabels.length > 0,
  );

  const allSeries: PrometheusParsedSeries[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const m = METRIC_LINE_RE.exec(line);
    if (!m || !m.groups) continue;

    const name = m.groups.name;

    if (includeRes.length > 0 && !includeRes.some((r) => fullMatch(r, name))) continue;
    if (excludeRes.length > 0 && excludeRes.some((r) => fullMatch(r, name))) continue;

    const valueStr = m.groups.value;
    const value = parseFloatStrict(valueStr);
    if (value === null) continue;

    const labels: Record<string, string> = { __name__: name };
    const rawLabels = m.groups.labels;
    if (rawLabels) {
      LABEL_RE.lastIndex = 0;
      let lm: RegExpExecArray | null;
      while ((lm = LABEL_RE.exec(rawLabels)) !== null) {
        labels[lm[1]] = lm[2].replace(/\\"/g, '"');
      }
    }

    for (const [k, v] of Object.entries(extraLabels)) {
      labels[k] = v;
    }

    allSeries.push({ name, labels, value });
  }

  if (!useFilter || !filterLabels || filterMetric === undefined || filterValue === null || filterValue === undefined) {
    return allSeries;
  }

  const activeKeys = new Set<string>();
  for (const s of allSeries) {
    if (s.name === filterMetric && s.value === filterValue) {
      activeKeys.add(JSON.stringify(filterLabels.map((gl) => (gl in s.labels ? s.labels[gl] : ''))));
    }
  }

  return allSeries.filter((s) =>
    activeKeys.has(JSON.stringify(filterLabels.map((gl) => (gl in s.labels ? s.labels[gl] : '')))),
  );
}

@Injectable()
export class PrometheusMonitoringService {
  private readonly logger: PrometheusMonitoringLogger;
  private readonly fetcher: PrometheusFetcher | null;
  private readonly snappy: SnappyCompressor | null;
  private readonly dnsLookup: DnsLookup;

  constructor(
    logger: ContextLogger,
    @Optional() @Inject(PROMETHEUS_FETCH) fetcher?: PrometheusFetcher,
    @Optional() @Inject(PROMETHEUS_SNAPPY) snappy?: SnappyCompressor,
    @Optional() @Inject(PROMETHEUS_DNS_LOOKUP) dnsLookupOverride?: DnsLookup,
  ) {
    this.logger = logger;
    this.fetcher = fetcher ?? null;
    this.snappy = snappy ?? null;
    this.dnsLookup = dnsLookupOverride ?? DEFAULT_DNS_LOOKUP;
  }

  jobId = '';

  async scrapeMetrics(opts: PrometheusScrapeOptions): Promise<string> {
    const protocol = opts.protocol ?? 'http';
    const timeout = opts.timeout ?? 15;
    const url = `${protocol}://${opts.targetIp}:${opts.port}${opts.metricsPath}`;
    await this.logger.info(`Scraping Prometheus metrics from ${url}`, { jobId: this.jobId });

    if (!this.fetcher) {
      throw new PrometheusMonitoringError('Prometheus fetcher not configured');
    }

    let response;
    try {
      response = await this.fetcher.get(url, timeout);
    } catch (error) {
      const message = `Connection error scraping ${url}: ${getErrorMessage(error)}`;
      await this.logger.error(message, { jobId: this.jobId });
      throw new PrometheusMonitoringError(message);
    }

    if (response.status !== 200) {
      const body = await response.text();
      const message = `Prometheus endpoint returned HTTP ${response.status}: ${body.slice(0, 200)}`;
      await this.logger.error(message, { jobId: this.jobId });
      throw new PrometheusMonitoringError(message);
    }

    const text = await response.text();
    await this.logger.debug(`Prometheus scrape successful - ${text.length} bytes from ${opts.targetIp}:${opts.port}`, {
      jobId: this.jobId,
    });
    return text;
  }

  async verifyRemoteWriteTarget(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const rawHost = parsed.hostname;
    if (!rawHost) return;
    const hostname = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    if (!hostname) return;

    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await this.dnsLookup(hostname);
    } catch (error) {
      throw new PrometheusMonitoringError(
        `Cannot resolve remote_write_url hostname ${hostname}: ${getErrorMessage(error)}`,
      );
    }

    for (const entry of resolved) {
      const ipStr = entry.address;
      const family = isIP(ipStr);
      if (family === 0) continue;
      if (family === 4) {
        if (ipv4IsBlockedForSsrf(ipStr)) {
          throw new PrometheusMonitoringError(
            `remote_write_url hostname ${hostname} resolves to private/reserved address ${ipStr}`,
          );
        }
      } else {
        const collapsed = collapseIpv4Mapped(ipStr);
        if (collapsed !== null) {
          if (ipv4IsBlockedForSsrf(collapsed)) {
            throw new PrometheusMonitoringError(
              `remote_write_url hostname ${hostname} resolves to private/reserved address ${ipStr}`,
            );
          }
        } else if (ipv6IsBlockedForSsrf(ipStr)) {
          throw new PrometheusMonitoringError(
            `remote_write_url hostname ${hostname} resolves to private/reserved address ${ipStr}`,
          );
        }
      }
    }
  }

  parsePrometheusText(text: string, options: PrometheusParseOptions = {}): PrometheusParsedSeries[] {
    return parsePrometheusText(text, options);
  }

  async scrapeAndPush(opts: PrometheusScrapeAndPushOptions): Promise<PrometheusPushResult> {
    const text = await this.scrapeMetrics({
      targetIp: opts.targetIp,
      port: opts.port,
      metricsPath: opts.metricsPath,
      protocol: opts.protocol,
      timeout: opts.timeout,
    });

    const extraLabels: Record<string, string> = {};
    if (opts.hostName) {
      extraLabels.hostname = opts.hostName;
    }

    const seriesList = parsePrometheusText(text, {
      extraLabels,
      metricInclude: opts.metricInclude,
      metricExclude: opts.metricExclude,
      filterMetric: opts.filterMetric,
      filterValue: opts.filterValue,
      filterLabels: opts.filterLabels,
    });

    if (seriesList.length === 0) {
      await this.logger.info('No metrics parsed from scrape — nothing to push', {
        jobId: this.jobId,
      });
      return {
        result: 'success',
        metrics_pushed: 0,
        host_name: opts.hostName ?? '',
      };
    }

    await this.verifyRemoteWriteTarget(opts.remoteWriteUrl);

    const nowMs = Date.now();
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-protobuf',
      'Content-Encoding': 'snappy',
      'X-Prometheus-Remote-Write-Version': '0.1.0',
    };

    if (opts.remoteWriteUsername && opts.remoteWritePassword) {
      const creds = Buffer.from(`${opts.remoteWriteUsername}:${opts.remoteWritePassword}`).toString('base64');
      headers.Authorization = `Basic ${creds}`;
    }

    if (!this.fetcher) {
      throw new PrometheusMonitoringError('Prometheus fetcher not configured');
    }
    if (!this.snappy) {
      throw new PrometheusMonitoringError('Snappy compressor not configured');
    }

    const total = seriesList.length;
    let pushed = 0;
    const errors: string[] = [];

    for (let batchStart = 0; batchStart < total; batchStart += BATCH_SIZE) {
      const batch = seriesList.slice(batchStart, batchStart + BATCH_SIZE);
      const writeReq = new WriteRequest();

      for (const s of batch) {
        const ts = new TimeSeries();
        const sortedLabelNames = Object.keys(s.labels).sort();
        for (const lname of sortedLabelNames) {
          ts.addLabel(new Label(lname, s.labels[lname]));
        }
        ts.addSample(new Sample(s.value, BigInt(nowMs)));
        writeReq.addTimeseries(ts);
      }

      const protoBytes = writeReq.serializeToString();
      const compressed = this.snappy.compress(protoBytes);

      try {
        const resp = await this.fetcher.post(opts.remoteWriteUrl, compressed, headers, opts.timeout);
        if (resp.status === 200 || resp.status === 204) {
          pushed += batch.length;
        } else {
          const body = await resp.text();
          const errMsg = `Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}: HTTP ${resp.status}: ${body.slice(0, 200)}`;
          await this.logger.error(errMsg, { jobId: this.jobId });
          errors.push(errMsg);
        }
      } catch (error) {
        const errMsg = `Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}: connection error: ${getErrorMessage(error)}`;
        await this.logger.error(errMsg, { jobId: this.jobId });
        errors.push(errMsg);
      }
    }

    await this.logger.info(
      `Remote write done — ${pushed}/${total} metrics pushed (${errors.length} batch errors) to ${opts.remoteWriteUrl}`,
      { jobId: this.jobId },
    );

    if (errors.length > 0 && pushed === 0) {
      return {
        result: 'failure',
        error: errors.slice(0, 3).join('; '),
        metrics_pushed: 0,
        host_name: opts.hostName ?? '',
      };
    }

    if (errors.length > 0) {
      return {
        result: 'partial',
        error: errors.slice(0, 3).join('; '),
        metrics_pushed: pushed,
        metrics_failed: total - pushed,
        host_name: opts.hostName ?? '',
      };
    }

    return {
      result: 'success',
      metrics_pushed: pushed,
      host_name: opts.hostName ?? '',
    };
  }
}

export function createPrometheusMonitoringService(
  jobId = '',
  logger: ContextLogger = new ContextLogger(),
  fetcher?: PrometheusFetcher,
  snappy?: SnappyCompressor,
  dnsLookupOverride?: DnsLookup,
): PrometheusMonitoringService {
  const svc = new PrometheusMonitoringService(logger, fetcher, snappy, dnsLookupOverride);
  svc.jobId = jobId;
  return svc;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = result * 256 + n;
  }
  return result;
}

function inIpv4Range(ip: string, start: string, end: string): boolean {
  const n = ipv4ToNumber(ip);
  const s = ipv4ToNumber(start);
  const e = ipv4ToNumber(end);
  if (n === null || s === null || e === null) return false;
  return n >= s && n <= e;
}

const IPV4_BLOCKED_EXCEPTIONS = new Set(['192.0.0.9', '192.0.0.10']);

function ipv4IsBlockedForSsrf(ip: string): boolean {
  if (IPV4_BLOCKED_EXCEPTIONS.has(ip)) return false;
  if (inIpv4Range(ip, '127.0.0.0', '127.255.255.255')) return true;
  if (inIpv4Range(ip, '10.0.0.0', '10.255.255.255')) return true;
  if (inIpv4Range(ip, '172.16.0.0', '172.31.255.255')) return true;
  if (inIpv4Range(ip, '192.168.0.0', '192.168.255.255')) return true;
  if (inIpv4Range(ip, '169.254.0.0', '169.254.255.255')) return true;
  if (inIpv4Range(ip, '0.0.0.0', '0.255.255.255')) return true;
  if (inIpv4Range(ip, '192.0.0.0', '192.0.0.255')) return true;
  if (inIpv4Range(ip, '192.0.2.0', '192.0.2.255')) return true;
  if (inIpv4Range(ip, '198.18.0.0', '198.19.255.255')) return true;
  if (inIpv4Range(ip, '198.51.100.0', '198.51.100.255')) return true;
  if (inIpv4Range(ip, '203.0.113.0', '203.0.113.255')) return true;
  if (inIpv4Range(ip, '240.0.0.0', '255.255.255.255')) return true;
  return false;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const lower = ip.toLowerCase();
  const pctIdx = lower.indexOf('%');
  const bare = pctIdx >= 0 ? lower.slice(0, pctIdx) : lower;
  const parts = bare.split('::');
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

function collapseIpv4Mapped(ip: string): string | null {
  const n = ipv6ToBigInt(ip);
  if (n === null) return null;
  if (n >> 32n === 0xffffn) {
    const v4 = Number(n & 0xffffffffn);
    return `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`;
  }
  return null;
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

function ipv6IsBlockedForSsrf(ip: string): boolean {
  const addr = ipv6ToBigInt(ip);
  if (addr === null) return false;
  if (IPV6_BLOCKED_EXCEPTIONS.some(([net, plen]) => ipv6InNetwork(addr, net, plen))) {
    return false;
  }
  return IPV6_BLOCKED_NETWORKS.some(([net, plen]) => ipv6InNetwork(addr, net, plen));
}
