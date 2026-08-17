import http from 'node:http';
import https from 'node:https';

import { isRecord } from '@repo/utils';

import { getRedfishConfig } from './oob.config.js';

import { getLogger } from '../logger/logger.service';
import { redactSensitive } from '../redfish/redact.js';
import {
  isTlsCertVerificationError,
  redfishRejectUnauthorized,
  redfishTlsVerificationFailureHint,
  warnRedfishTlsVerificationDisabledOnce,
} from '../redfish/redfish.config.js';
import { pythonFalsy } from '../saga-framework/truthiness';

let warnedTlsVerificationFailure = false;
function warnRedfishTlsVerificationFailureOnce(host: string): void {
  if (warnedTlsVerificationFailure) return;
  warnedTlsVerificationFailure = true;
  void getLogger().warning(redfishTlsVerificationFailureHint(host));
}

export class RedfishError extends Error {
  readonly statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = 'RedfishError';
    this.statusCode = statusCode;
  }
}

export interface RedfishHttpResponse {
  status: number;
  body: Buffer;
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

function defaultRequester(params: RedfishRequestParams): Promise<RedfishHttpResponse> {
  return new Promise<RedfishHttpResponse>((resolve, reject) => {
    const url = new URL(params.url);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const rejectUnauthorized = redfishRejectUnauthorized();
    if (isHttps && !rejectUnauthorized)
      warnRedfishTlsVerificationDisabledOnce((m) => void getLogger().warning(m), url.host);
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
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: responseHeaders });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${params.timeoutS}s`));
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

export interface RedfishOperationResult {
  status: number;
  content: Buffer;
  headers: Record<string, string>;
}

export interface RedfishProxyServiceOptions {
  requester?: RedfishRequester;
}

export class RedfishProxyService {
  readonly jobId: string;
  readonly config = getRedfishConfig();
  private readonly requester: RedfishRequester;

  constructor(jobId = '', options: RedfishProxyServiceOptions = {}) {
    this.jobId = jobId;
    this.requester = options.requester ?? defaultRequester;
  }

  async validatePayload(payload: Record<string, unknown>): Promise<void> {
    void getLogger().debug(`Starting Redfish payload validation for job ${this.jobId}`, { jobId: this.jobId });
    void getLogger().info('Validating Redfish payload', { jobId: this.jobId });

    void getLogger().info(`Payload: ${JSON.stringify(redactSensitive(payload))}`, { jobId: this.jobId });

    const requiredFields = ['bmc_ip', 'endpoint', 'method', 'username', 'password'];
    void getLogger().debug(`Checking for required fields: ${requiredFields.join(', ')}`, { jobId: this.jobId });
    const missingFields = requiredFields.filter((field) => pythonFalsy(payload[field]));
    if (missingFields.length > 0) {
      const errorMsg = `Missing or empty required fields: ${missingFields.join(', ')}`;
      void getLogger().error(errorMsg, { jobId: this.jobId });
      throw new RedfishError(errorMsg);
    }

    const portRaw = 'port' in payload ? payload['port'] : 443;
    const portInt =
      portRaw === true
        ? 1
        : portRaw === false
          ? 0
          : typeof portRaw === 'number' && Number.isInteger(portRaw)
            ? portRaw
            : null;
    if (portInt === null || portInt < 1 || portInt > 65535) {
      const portDisplay = portRaw === true ? 'True' : portRaw === false ? 'False' : String(portRaw);
      const errorMsg = `Invalid port number: ${portDisplay}. Must be between 1 and 65535`;
      void getLogger().error(errorMsg, { jobId: this.jobId });
      throw new RedfishError(errorMsg);
    }

    // Non-string truthy method must surface as TypeError (HTTP 500), not RedfishError (HTTP 400).
    const methodRaw = 'method' in payload ? payload['method'] : '';
    if (methodRaw !== '' && typeof methodRaw !== 'string') {
      throw new TypeError(
        `Cannot call toUpperCase on ${methodRaw === null ? 'null' : typeof methodRaw} (expected string)`,
      );
    }
    const method = typeof methodRaw === 'string' ? methodRaw.toUpperCase() : '';
    const validMethods = ['GET', 'PATCH', 'PUT', 'POST'];
    void getLogger().debug(`Validating HTTP method: ${method} against valid methods: ${validMethods.join(', ')}`, {
      jobId: this.jobId,
    });
    if (!validMethods.includes(method)) {
      const errorMsg = `Invalid method: ${method}. Valid methods: [${validMethods.map((m) => `'${m}'`).join(', ')}]`;
      void getLogger().error(errorMsg, { jobId: this.jobId });
      throw new RedfishError(errorMsg);
    }

    const dataPayload = payload['payload'] ?? null;
    if (
      (method === 'GET' && dataPayload !== null) ||
      (['POST', 'PUT', 'PATCH'].includes(method) && dataPayload === null)
    ) {
      const errorMsg = `Invalid payload for method ${method}`;
      void getLogger().error(errorMsg, { jobId: this.jobId });
      throw new RedfishError(errorMsg);
    }

    void getLogger().info('Payload validation successful', { jobId: this.jobId });
  }

  async buildRequestHeaders(payload: Record<string, unknown>): Promise<Record<string, string>> {
    void getLogger().debug('Building Redfish request headers', { jobId: this.jobId });
    let headers = payload['headers'];
    const hasMethod = 'method' in payload;
    const methodRaw = hasMethod ? payload['method'] : '';
    let method: string;
    if (typeof methodRaw === 'string') {
      method = methodRaw.toUpperCase();
    } else if (methodRaw === null || methodRaw === undefined) {
      throw new TypeError(`Cannot call toUpperCase on ${methodRaw === null ? 'null' : 'undefined'} (expected string)`);
    } else {
      throw new TypeError(`Cannot call toUpperCase on ${typeof methodRaw} (expected string)`);
    }

    if (pythonFalsy(headers)) {
      void getLogger().debug(`Using default headers with content type: ${this.config.defaultContentType}`, {
        jobId: this.jobId,
      });
      headers = `{"Content-Type": "${this.config.defaultContentType}", "Accept": "application/json"}`;
    }

    let parsedHeaders: Record<string, string>;
    if (typeof headers === 'string') {
      void getLogger().debug('Parsing headers from JSON string', { jobId: this.jobId });
      let parsed: unknown;
      try {
        parsed = JSON.parse(headers);
      } catch (e) {
        throw new RedfishError(`Invalid headers JSON: ${String(e)}`);
      }
      parsedHeaders = {};
      if (isRecord(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          parsedHeaders[k] = typeof v === 'string' ? v : String(v);
        }
      }
    } else if (isRecord(headers)) {
      parsedHeaders = {};
      for (const [k, v] of Object.entries(headers)) {
        parsedHeaders[k] = typeof v === 'string' ? v : String(v);
      }
    } else {
      parsedHeaders = {};
    }

    if ((method === 'PATCH' || method === 'DELETE') && !('If-Match' in parsedHeaders)) {
      void getLogger().debug(`Adding If-Match header for ${method} operation`, { jobId: this.jobId });
      parsedHeaders['If-Match'] = '*';
    }

    return parsedHeaders;
  }

  async buildRequestUrl(bmcIp: string, payload: Record<string, unknown>): Promise<string> {
    const protocol = 'protocol' in payload ? String(payload['protocol']) : 'https';
    const port = 'port' in payload ? String(payload['port']) : '443';
    const endpoint = String(payload['endpoint']);

    const url = `${protocol}://${bmcIp}:${port}${endpoint}`;
    void getLogger().debug(`Built Redfish URL: ${url}`, { jobId: this.jobId });
    return url;
  }

  async executeRedfishRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    username: string,
    password: string,
    dataPayload: unknown = null,
  ): Promise<RedfishOperationResult> {
    void getLogger().debug(`Starting Redfish ${method} request execution to URL: ${url}`, { jobId: this.jobId });
    void getLogger().info(`Executing Redfish ${method} request`, { jobId: this.jobId });

    try {
      void getLogger().debug(
        `Sending ${method} request with ${Object.keys(headers).length} headers and payload: ${dataPayload !== null}`,
        {
          jobId: this.jobId,
        },
      );
      void getLogger().info('Sending request to Redfish API', { jobId: this.jobId });

      const response = await this.requester({
        url,
        method,
        headers,
        username,
        password,
        body: dataPayload !== null ? JSON.stringify(dataPayload) : null,
        timeoutS: this.config.timeout,
      });

      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        const lower = name.toLowerCase();
        if (lower === 'content-encoding' || lower === 'content-length') {
          void getLogger().debug(`Removing header ${name}: ${value}`, { jobId: this.jobId });
          continue;
        }
        responseHeaders[name] = value;
      }

      void getLogger().debug(
        `Received response: status=${response.status}, content_length=${response.body.length}, headers_count=${Object.keys(responseHeaders).length}`,
        { jobId: this.jobId },
      );
      void getLogger().info(`Received Redfish API response - Status: ${response.status}`, { jobId: this.jobId });

      return { status: response.status, content: response.body, headers: responseHeaders };
    } catch (e) {
      if (e instanceof RedfishError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('APPLICATION_DATA_AFTER_CLOSE_NOTIFY')) {
        void getLogger().debug(`SSL close notify error (non-critical) during Redfish request: ${msg}`, {
          jobId: this.jobId,
        });
        throw new TypeError('RedfishError() takes no keyword arguments');
      }
      const errorMsg = `HTTP client error during Redfish request: ${String(e)}`;
      void getLogger().error(errorMsg, { jobId: this.jobId });
      throw new RedfishError(errorMsg);
    }
  }

  async prepareResponseHeaders(responseHeaders: Record<string, string>): Promise<Record<string, string>> {
    if (!('Content-Type' in responseHeaders)) {
      responseHeaders['Content-Type'] = 'application/json';
    }

    void getLogger().info('Response headers prepared', { jobId: this.jobId });
    return responseHeaders;
  }

  async performRedfishOperation(payload: Record<string, unknown>): Promise<RedfishOperationResult> {
    void getLogger().debug(`Starting complete Redfish operation for job ${this.jobId}`, { jobId: this.jobId });
    void getLogger().info('Starting Redfish operation', { jobId: this.jobId });

    await this.validatePayload(payload);

    const bmcIp = String(payload['bmc_ip']);
    const username = String(payload['username']);
    const password = String(payload['password']);
    const method = String(payload['method']).toUpperCase();
    const dataPayload: unknown = payload['payload'] ?? null;

    void getLogger().debug(
      `Extracted parameters - BMC IP: ${bmcIp}, method: ${method}, has_payload: ${dataPayload !== null}`,
      {
        jobId: this.jobId,
      },
    );

    const endpoint = payload['endpoint'] ?? 'unknown';
    void getLogger().info(`Redfish operation: ${method} ${String(endpoint)}`, { jobId: this.jobId });

    void getLogger().debug('Building Redfish request components', { jobId: this.jobId });
    const url = await this.buildRequestUrl(bmcIp, payload);
    const headers = await this.buildRequestHeaders(payload);

    void getLogger().debug('Executing Redfish API request', { jobId: this.jobId });
    const result = await this.executeRedfishRequest(url, method, headers, username, password, dataPayload);

    void getLogger().debug('Preparing response headers for client', { jobId: this.jobId });
    const preparedHeaders = await this.prepareResponseHeaders(result.headers);

    void getLogger().info(`Redfish operation completed successfully - Status: ${result.status}`, { jobId: this.jobId });
    return { status: result.status, content: result.content, headers: preparedHeaders };
  }
}

export function createRedfishProxyService(jobId = '', options: RedfishProxyServiceOptions = {}): RedfishProxyService {
  return new RedfishProxyService(jobId, options);
}
