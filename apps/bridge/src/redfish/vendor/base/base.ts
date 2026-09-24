import http from 'node:http';
import https from 'node:https';

import { isRecord } from '@repo/utils';
import { z } from 'zod';
import { envInt } from '../../../common/env-utils.js';
import { getLogger } from '../../../logger/logger.service.js';
import { type BmcCoordinates, bmcCoordinates } from '../../bmc-coordinates.js';
import { redactSensitive } from '../../redact.js';
import {
  isTlsCertVerificationError,
  redfishRejectUnauthorized,
  redfishTlsVerificationFailureHint,
  warnRedfishTlsVerificationDisabledOnce,
} from '../../redfish.config.js';

const APP_CLASS = 'adapters-redfish';

let warnedTlsVerificationFailure = false;
function warnRedfishTlsVerificationFailureOnce(host: string): void {
  if (warnedTlsVerificationFailure) return;
  warnedTlsVerificationFailure = true;
  logger.warning(redfishTlsVerificationFailureHint(host), { appClassName: APP_CLASS });
}

export interface LogContext {
  jobId?: string;
  appClassName?: string;
}

export const logger = {
  debug(message: string, context: LogContext = {}): void {
    void getLogger().debug(message, context);
  },
  info(message: string, context: LogContext = {}): void {
    void getLogger().info(message, context);
  },
  warning(message: string, context: LogContext = {}): void {
    void getLogger().warning(message, context);
  },
  error(message: string, context: LogContext = {}): void {
    void getLogger().error(message, context);
  },
};

export interface RedfishHttpResponse {
  status: number;
  text: string;
  headers: Record<string, string>;
}

export interface RedfishRequestParams {
  url: string;
  method: string;
  headers: Record<string, string>;
  username: string;
  password: string;
  body: string | null;
  timeoutS: number;
}

export type RedfishRequester = (params: RedfishRequestParams) => Promise<RedfishHttpResponse>;

class RedfishRequestTimeout extends Error {
  constructor(timeoutS: number) {
    super(`request timed out after ${timeoutS}s`);
    this.name = 'TimeoutError';
  }
}

export function defaultRedfishRequester(params: RedfishRequestParams): Promise<RedfishHttpResponse> {
  return new Promise<RedfishHttpResponse>((resolve, reject) => {
    const url = new URL(params.url);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const rejectUnauthorized = redfishRejectUnauthorized();
    if (isHttps && !rejectUnauthorized)
      warnRedfishTlsVerificationDisabledOnce((m) => logger.warning(m, { appClassName: APP_CLASS }), url.host);
    const auth = Buffer.from(`${params.username}:${params.password}`, 'utf8').toString('base64');
    const headers: Record<string, string> = { ...params.headers, Authorization: `Basic ${auth}` };
    if (params.body !== null && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(params.body, 'utf8'));
    }
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: params.method,
        headers,
        timeout: params.timeoutS * 1000,
        ...(isHttps ? { rejectUnauthorized } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders[name] = value;
            } else if (Array.isArray(value)) {
              responseHeaders[name] = value.join(', ');
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            headers: responseHeaders,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new RedfishRequestTimeout(params.timeoutS));
    });
    req.on('error', (err) => {
      if (rejectUnauthorized && isTlsCertVerificationError(err)) warnRedfishTlsVerificationFailureOnce(url.host);
      reject(err);
    });
    if (params.body !== null) {
      req.write(params.body);
    }
    req.end();
  });
}

export type JsonRecord = Record<string, unknown>;

export interface CallStackEntry {
  method: string;
  endpoint: string;
  request: JsonRecord;
  response: JsonRecord | null;
  responseHeaders: Record<string, string>;
  status: number | null;
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

export function isEmptyRecord(value: JsonRecord): boolean {
  return Object.keys(value).length === 0;
}

export class UninitializedVariableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UninitializedVariableError';
  }
}

export class RecordKeyError extends Error {
  constructor(key: string) {
    super(`RecordKeyError: ${JSON.stringify(key)}`);
    this.name = 'RecordKeyError';
  }
}

export class RecordIndexError extends Error {
  constructor(message = 'index out of range') {
    super(`RecordIndexError: ${message}`);
    this.name = 'RecordIndexError';
  }
}

export class RecordTypeError extends Error {
  constructor(message: string) {
    super(`RecordTypeError: ${message}`);
    this.name = 'RecordTypeError';
  }
}

export class PropertyAccessError extends Error {
  constructor(message: string) {
    super(`PropertyAccessError: ${message}`);
    this.name = 'PropertyAccessError';
  }
}

/** Redfish mixes boolean and integer encodings (0↔false, 1↔true), so a numeric `current` is tolerated. */
export function redfishBoolMatches(current: unknown, desired: boolean): boolean {
  return (
    current === desired ||
    (typeof desired === 'boolean' && typeof current === 'number' && (desired ? 1 : 0) === current)
  );
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Loose BIOS value equality: identical, boolean/number coerced (0 ↔ false, 1 ↔ true), or deep-equal. */
export function biosValuesEqual(a: unknown, b: unknown): boolean {
  return (
    a === b ||
    (typeof a === 'boolean' && typeof b === 'number' && (a ? 1 : 0) === b) ||
    (typeof b === 'boolean' && typeof a === 'number' && (b ? 1 : 0) === a) ||
    deepEqual(a, b)
  );
}

/** Returns the subset of `pending` entries whose value is not loosely equal to `current`. */
export function diffBiosPendingParams(pendingEntries: Iterable<[string, unknown]>, current: JsonRecord): JsonRecord {
  const pending: JsonRecord = {};
  for (const [key, value] of pendingEntries) {
    const currentValue = key in current ? current[key] : null;
    if (!biosValuesEqual(currentValue ?? null, value === undefined ? null : value)) {
      pending[key] = value;
    }
  }
  return pending;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MISS: unique symbol = Symbol('miss');

export function isDigitString(value: string): boolean {
  return /^\d+$/.test(value);
}

function traverse(obj: unknown, path: string, separator: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(separator)) {
    if (isDigitString(key)) {
      const index = parseInt(key, 10);
      if (Array.isArray(current)) {
        if (index < 0 || index >= current.length) return MISS;
        current = current[index];
      } else if (typeof current === 'string') {
        if (index < 0 || index >= current.length) return MISS;
        current = current.charAt(index);
      } else if (isRecord(current)) {
        return MISS;
      } else {
        return MISS;
      }
    } else if (isRecord(current)) {
      if (!(key in current)) return MISS;
      current = current[key];
    } else {
      return MISS;
    }
  }
  return current;
}

export function extractNestedValue(obj: unknown, path: string, separator = '_', defaultValue: unknown = null): unknown {
  if (obj == null || !path) return defaultValue;
  const result = traverse(obj, path, separator);
  return result === MISS ? defaultValue : result;
}

const DEFAULT_REBOOT_WAITS = 15;
const DEFAULT_REBOOT_TIMEOUT_S = 45;

const rebootBudgetEnvSchema = z.object({
  REDFISH_REBOOT_WAITS: envInt(DEFAULT_REBOOT_WAITS),
  REDFISH_REBOOT_TIMEOUT_S: envInt(DEFAULT_REBOOT_TIMEOUT_S),
});

export interface RebootBudget {
  waits: number;
  timeoutS: number;
}

// POST with TME enabled retrains memory, so a large box can outlast the 15 × 45 s default
export function rebootBudget(env: NodeJS.ProcessEnv = process.env): RebootBudget {
  const { REDFISH_REBOOT_WAITS: waits, REDFISH_REBOOT_TIMEOUT_S: timeoutS } = rebootBudgetEnvSchema.parse(env);
  return { waits, timeoutS };
}

export class RedfishDevice {
  jobId: string;
  deviceId: string;
  bmcIp: string;
  username: string;
  password: string;

  protocol: BmcCoordinates['protocol'];
  port: number;
  rebootTimeout: number;
  rebootWaits: number;
  rebootNeeded = false;
  lastHostResetAt: number | null = null; // epoch seconds
  biosRetryAttempts = 15;

  callStack: CallStackEntry[] = [];

  vendor = '';
  controller = '';
  modelFull = '';
  model = '';
  bootState = '';
  bootOptions: string[] = [];

  accountserviceEndpoint = '';
  jobserviceEndpoint = '';
  chassisEndpoint = '';
  managerEndpoint = '';
  networkEndpoint = '';
  rebootEndpoint = '';
  redfishEndpoint = '';
  registriesEndpoint = '';
  securebootEndpoint = '';
  storageEndpoint = '';
  systemEndpoint = '';

  biosGetEndpoint = '';
  biosPatchEndpoint = '';
  biosParams: JsonRecord = {};
  biosPendingParams: JsonRecord = {};

  registry: Record<string, JsonRecord> = {};

  dellLcServiceEndpoint?: string;
  jobsByState?: Record<string, JsonRecord[]>;
  displayNameToAttr?: Record<string, string>;

  constructor(jobId: string, deviceId: string, bmcIp: string, username = '', password = '') {
    this.jobId = jobId;
    this.deviceId = deviceId;
    this.bmcIp = bmcIp;
    this.username = username;
    this.password = password;
    const coords = bmcCoordinates(bmcIp);
    this.protocol = coords.protocol;
    this.port = coords.port;
    const budget = rebootBudget();
    this.rebootTimeout = budget.timeoutS;
    this.rebootWaits = budget.waits;
  }

  tag(): string {
    return `${this.vendor}.${this.controller}.${this.model}`.toLowerCase();
  }
}

export class RedfishBaseHandler {
  device: RedfishDevice;
  jobId: string;
  /** @internal Public so vendor profiles can construct sibling handlers with the same injected requester. */
  readonly requester: RedfishRequester;

  constructor(device: RedfishDevice, jobId = '', requester: RedfishRequester = defaultRedfishRequester) {
    this.device = device;
    this.jobId = jobId;
    this.requester = requester;
  }

  async fetch(
    method: string,
    endpoint: string,
    payload: JsonRecord,
    headers?: Record<string, string>,
    timeout = 60,
  ): Promise<JsonRecord> {
    const requestHeaders: Record<string, string> = {
      ...(headers ?? {}),
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'Content-Type': 'application/json',
    };

    const url = `${this.device.protocol}://${this.device.bmcIp}:${this.device.port}${endpoint}`;
    const hasBody = !isEmptyRecord(payload);

    const entry: CallStackEntry = {
      method,
      endpoint,
      request: payload,
      response: null,
      responseHeaders: {},
      status: null,
    };
    this.device.callStack.push(entry);

    let responseText: string;
    let responseStatus: number;
    const responseHeaders: Record<string, string> = {};
    try {
      logger.debug(
        `curl -X ${method} -H ` +
          Object.entries(requestHeaders)
            .map(([key, value]) => `'${key}: ${value}'`)
            .join(' -H ') +
          ` ${url}` +
          (hasBody ? ` -d '${JSON.stringify(redactSensitive(payload))}'` : ''),
        { jobId: this.device.jobId, appClassName: APP_CLASS },
      );

      const response = await this.requester({
        url,
        method,
        headers: requestHeaders,
        username: this.device.username,
        password: this.device.password,
        body: hasBody ? JSON.stringify(payload) : null,
        timeoutS: timeout,
      });
      responseText = response.text;
      responseStatus = response.status;
      for (const [key, value] of Object.entries(response.headers)) {
        responseHeaders[key] = value;
      }
    } catch (err) {
      const CONNECTOR_CODES = new Set([
        'ECONNREFUSED',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EADDRNOTAVAIL',
        'ECONNRESET',
      ]);
      const errCode = err instanceof Error && 'code' in err ? (err as { code?: unknown }).code : undefined;
      if (typeof errCode === 'string' && CONNECTOR_CODES.has(errCode)) {
        const detail =
          err instanceof Error && err.cause instanceof Error
            ? err.cause.message
            : err instanceof Error
              ? err.message
              : String(err);
        logger.error(`Connection error to BMC at ${this.device.bmcIp}:${this.device.port} for ${endpoint}: ${detail}`, {
          jobId: this.jobId,
          appClassName: APP_CLASS,
        });
        return {};
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        logger.error(`request timeout for ${endpoint} (${timeout}s exceeded)`, {
          jobId: this.jobId,
          appClassName: APP_CLASS,
        });
        return {};
      }
      const name = err instanceof Error ? err.constructor.name : typeof err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`unhandled error for ${endpoint}: ${name}: ${message}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      return {};
    }

    entry.status = responseStatus;
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      entry.response = responseText.startsWith('<?xml') ? { xml: responseText } : { unknown: responseText };
      return entry.response;
    }

    entry.response = parsed as JsonRecord;
    entry.responseHeaders = responseHeaders;
    if (!isRecord(parsed)) {
      throw new PropertyAccessError(`cannot read property 'get' of ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    const extendedInfoRaw = '@Message.ExtendedInfo' in entry.response ? entry.response['@Message.ExtendedInfo'] : [];
    if (Array.isArray(extendedInfoRaw) ? extendedInfoRaw.length > 0 : !!extendedInfoRaw) {
      if (!Array.isArray(extendedInfoRaw)) {
        throw new RecordTypeError(`'${extendedInfoRaw === null ? 'null' : typeof extendedInfoRaw}' is not iterable`);
      }
      const messageValues = extendedInfoRaw.map((info) => {
        const rec = info as Record<string, unknown>;
        if (!rec || typeof rec !== 'object' || !('Message' in rec)) throw new RecordKeyError('Message');
        return rec['Message'];
      });
      for (const value of messageValues) {
        if (typeof value !== 'string') {
          throw new RecordTypeError(`expected string in array, got ${typeof value}`);
        }
      }
      const messages = (messageValues as string[]).join(' ');
      logger.info(`extended info: ${messages}`, { jobId: this.jobId, appClassName: APP_CLASS });
    } else if ('error' in entry.response) {
      logger.error(`failed to fetch ${endpoint}: ${JSON.stringify(entry.response['error'])}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
    }

    return entry.response;
  }

  /** @internal Public so brand boot profiles (vendor/<brand>/) can extract BMC response paths. */
  extractNestedValue(
    obj: unknown,
    path: string,
    separator = '_',
    defaultValue: unknown = null,
    silent = true,
  ): unknown {
    if (obj == null || !path) return defaultValue;
    const result = traverse(obj, path, separator);
    if (result === MISS) {
      if (!silent) {
        logger.error(`failed to extract a value at path "${path}" from ${JSON.stringify(obj)}`, {
          jobId: this.jobId,
          appClassName: APP_CLASS,
        });
      }
      return defaultValue;
    }
    return result;
  }

  /** @internal Public so brand boot profiles (vendor/<brand>/) can extract BMC response paths. */
  extractString(obj: unknown, path: string, separator = '_'): string | null {
    const value = this.extractNestedValue(obj, path, separator);
    return typeof value === 'string' ? value : null;
  }

  /** @internal Public so brand discovery profiles (vendor/<brand>/) can read allowable-value arrays. */
  extractStringArray(obj: unknown, path: string): string[] {
    return asStringArray(this.extractNestedValue(obj, path, '_', []));
  }

  protected lastResponse(): JsonRecord | null {
    const last = this.device.callStack[this.device.callStack.length - 1];
    if (last === undefined) return null;
    return last.response;
  }

  protected lastResponseHeaders(): Record<string, string> {
    const last = this.device.callStack[this.device.callStack.length - 1];
    return last === undefined ? {} : last.responseHeaders;
  }

  protected lastResponseMessages(): unknown[] {
    const response = this.lastResponse();
    if (response === null) return [];
    const extendedInfoPath = 'error' in response ? 'error_@Message.ExtendedInfo' : '@Message.ExtendedInfo';
    const raw = this.extractNestedValue(response, extendedInfoPath, '_', []);
    if (!Array.isArray(raw)) {
      throw new RecordTypeError(`'${raw === null ? 'null' : typeof raw}' is not iterable`);
    }
    return raw.map((info) => {
      const rec = info as Record<string, unknown>;
      if (!rec || typeof rec !== 'object' || !('Message' in rec)) throw new RecordKeyError('Message');
      return rec['Message'];
    });
  }

  protected lastResponseResolutions(): unknown[] {
    const response = this.lastResponse();
    if (response === null) return [];
    const extendedInfoPath = 'error' in response ? 'error_@Message.ExtendedInfo' : '@Message.ExtendedInfo';
    const raw = this.extractNestedValue(response, extendedInfoPath, '_', []);
    if (!Array.isArray(raw)) {
      throw new RecordTypeError(`'${raw === null ? 'null' : typeof raw}' is not iterable`);
    }
    return raw.map((info) => {
      const rec = info as Record<string, unknown>;
      if (!rec || typeof rec !== 'object' || !('Resolution' in rec)) throw new RecordKeyError('Resolution');
      return rec['Resolution'];
    });
  }
}
