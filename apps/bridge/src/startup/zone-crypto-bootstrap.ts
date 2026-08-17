import { createHmac, generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getErrorMessage, hasErrnoCode } from '../common/error-utils';

import { RedisEncryptionError } from '../common/redis/redis-client/redis.errors.js';
import { KEY_SIZE } from '../zone-crypto/auth-dh.types.js';

import type { StartupLogger } from './startup-deps.types.js';

const APP_CLASS_NAME = 'zone-crypto';

export const BOOTSTRAP_LOCK_KEY = 'zone_crypto:bootstrap_lock';
export const BOOTSTRAP_LOCK_TTL_SECONDS = 600;
const ENROLL_NETWORK_RETRY_ATTEMPTS = 5;

export interface ZoneCryptoCache {
  secretGet(key: string, jobId?: string): Promise<string | null>;
  secretSet(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown>;
  acquireLock(lockKey: string, timeout?: number, jobId?: string): Promise<string | null>;
  releaseLock(lockKey: string, token: string, jobId?: string): Promise<boolean>;
}

export interface ZoneCryptoConfig {
  hubUrl: string;
  cacheKey: string;
  markerPath: string;
  registrationToken: string;
  httpTimeoutSeconds: number;
  pollTotalTimeoutSeconds: number;
  pollInitialBackoffSeconds: number;
  pollMaxBackoffSeconds: number;
}

export interface ZoneCryptoSnapshot {
  zonePriv: Buffer;
  zonePub: Buffer;
  hubPub: Buffer;
  enrolledAt: number;
}

export interface ZoneCryptoCodec {
  fromCacheBlob(blob: Buffer): ZoneCryptoSnapshot;
  toCacheBlob(state: ZoneCryptoSnapshot): Buffer;
  setActive(state: ZoneCryptoSnapshot): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

class EnrollmentError extends Error {
  constructor(
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

function decodeHex(hex: string): Buffer {
  const out: number[] = [];
  let firstNibble = -1;
  for (let i = 0; i < hex.length; i++) {
    const ch = hex.charCodeAt(i);
    const isAsciiWs = ch === 0x20 || (ch >= 0x09 && ch <= 0x0d);
    if (isAsciiWs) {
      if (firstNibble !== -1) {
        throw new Error(`non-hexadecimal number found in fromhex() arg at position ${i}`);
      }
      continue;
    }
    const nibble = hexNibble(ch);
    if (nibble === -1) {
      throw new Error(`non-hexadecimal number found in fromhex() arg at position ${i}`);
    }
    if (firstNibble === -1) {
      firstNibble = nibble;
    } else {
      out.push((firstNibble << 4) | nibble);
      firstNibble = -1;
    }
  }
  if (firstNibble !== -1) {
    throw new Error('fromhex() arg must contain an even number of hexadecimal digits');
  }
  return Buffer.from(out);
}

function hexNibble(ch: number): number {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
  return -1;
}

function hmacHex(key: Buffer, ...parts: (string | Buffer)[]): string {
  const mac = createHmac('sha256', key);
  for (const part of parts) {
    mac.update(typeof part === 'string' ? Buffer.from(part, 'utf8') : part);
  }
  return mac.digest('hex');
}

function generateX25519Keypair(): { zonePriv: Buffer; zonePub: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (typeof privJwk.d !== 'string' || typeof pubJwk.x !== 'string') {
    throw new Error('x25519 keypair export missing JWK components');
  }
  return {
    zonePriv: Buffer.from(privJwk.d, 'base64url'),
    zonePub: Buffer.from(pubJwk.x, 'base64url'),
  };
}

const AIOHTTP_JSON_RE = /^application\/(?:[\w.+-]+?\+)?json/;

function isAiohttpJsonContentType(contentType: string): boolean {
  return AIOHTTP_JSON_RE.test(contentType.toLowerCase());
}

async function defaultMarkerWriter(path: string, body: string): Promise<void> {
  const parent = dirname(path);
  if (parent) await mkdir(parent, { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, body, 'utf8');
  await rename(tmpPath, path);
}

export interface ZoneCryptoBootstrapOptions {
  cache: ZoneCryptoCache;
  config: ZoneCryptoConfig;
  zoneId: string;
  codec: ZoneCryptoCodec;
  logger?: StartupLogger;
  fetchImpl?: FetchLike;
  markerWriter?: (path: string, body: string) => Promise<void>;
  markerExists?: (path: string) => boolean;
  exit?: (code: number) => never;
  sleep?: (ms: number) => Promise<void>;
}

export class ZoneCryptoBootstrapService {
  private readonly jobId: string;
  private readonly config: ZoneCryptoConfig;
  private readonly zoneId: string;
  private readonly cache: ZoneCryptoCache;
  private readonly codec: ZoneCryptoCodec;
  private readonly logger: StartupLogger | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly markerWriter: (path: string, body: string) => Promise<void>;
  private readonly markerExists: (path: string) => boolean;
  private readonly exit: (code: number) => never;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(jobId: string, options: ZoneCryptoBootstrapOptions) {
    this.jobId = jobId;
    this.config = options.config;
    this.zoneId = options.zoneId;
    this.cache = options.cache;
    this.codec = options.codec;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.markerWriter = options.markerWriter ?? defaultMarkerWriter;
    this.markerExists = options.markerExists ?? existsSync;
    this.exit = options.exit ?? ((code: number) => process.exit(code));
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(): Promise<boolean> {
    if (!this.config.hubUrl) {
      this.logger?.info('BROKKR_HUB_URL not set; zone crypto bootstrap is dormant', {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return false;
    }
    if (!this.zoneId) {
      this.logger?.error(
        "BROKKR_ZONE_ID not set; cannot bootstrap zone crypto. Set this to the hub's Zone.id (UUID) issued at zone creation.",
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
      return false;
    }
    if (await this.tryLoadCache()) return true;
    return this.competeForEnrollment();
  }

  private async tryLoadCache(): Promise<boolean> {
    let blobStr: string | null;
    try {
      blobStr = await this.cache.secretGet(this.config.cacheKey, this.jobId);
    } catch (exc) {
      if (exc instanceof RedisEncryptionError) {
        await this.failClosedIfMarker('aead_decrypt_failed', exc.message);
        return false;
      }
      this.logger?.error(`zone_crypto cache load failed (redis_unavailable): ${getErrorMessage(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return false;
    }

    if (blobStr === null) return false;

    let state: ZoneCryptoSnapshot;
    try {
      state = this.codec.fromCacheBlob(Buffer.from(blobStr, 'utf8'));
    } catch (exc) {
      await this.failClosedIfMarker('schema_invalid', getErrorMessage(exc));
      return false;
    }

    this.codec.setActive(state);
    this.logger?.info(`zone_crypto loaded from cache for zone ${this.zoneId}`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });
    await this.writeMarkerBestEffort('cache_load');
    return true;
  }

  private async failClosedIfMarker(reason: string, detail: string): Promise<void> {
    if (this.markerExists(this.config.markerPath)) {
      this.logger?.error(
        `zone_crypto cache load failed (${reason}) and sticky marker ${this.config.markerPath} is present; ` +
          `failing closed to prevent silent plaintext downgrade. Operator action required: investigate ` +
          `BRIDGE_AT_REST_KEY rotation or at-rest tamper. Detail: ${detail}`,
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
      this.exit(1);
      return;
    }
    this.logger?.error(
      `zone_crypto cache load failed (${reason}); no sticky marker, treating as first-boot recoverable. Detail: ${detail}`,
      {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      },
    );
  }

  private async writeMarkerBestEffort(reason: string): Promise<void> {
    const path = this.config.markerPath;
    const payload = { reason, written_at: Date.now(), zone_id: this.zoneId };
    const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1)));
    try {
      await this.markerWriter(path, JSON.stringify(sorted));
    } catch (exc) {
      if (!hasErrnoCode(exc)) throw exc;
      this.logger?.warn(
        `zone_crypto sticky marker write failed (path=${path}, reason=${reason}): ${String(exc)}. ` +
          `Bridge will boot, but downgrade-attack protection is degraded until the marker can be written.`,
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
    }
  }

  private async competeForEnrollment(): Promise<boolean> {
    let lockToken: string | null;
    try {
      lockToken = await this.cache.acquireLock(BOOTSTRAP_LOCK_KEY, BOOTSTRAP_LOCK_TTL_SECONDS, this.jobId);
    } catch (exc) {
      this.logger?.error(`zone_crypto enrollment failed (lock_acquire_failed): ${getErrorMessage(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return false;
    }

    if (lockToken === null) {
      this.logger?.info(`zone_crypto bootstrap lock held elsewhere; entering follower poll for zone ${this.zoneId}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return this.pollAsFollower();
    }

    try {
      return await this.enrollAsLeader();
    } finally {
      try {
        await this.cache.releaseLock(BOOTSTRAP_LOCK_KEY, lockToken, this.jobId);
      } catch (exc) {
        this.logger?.warn(
          `zone_crypto bootstrap lock release failed (will TTL-expire after ${BOOTSTRAP_LOCK_TTL_SECONDS}s): ${getErrorMessage(exc)}`,
          { appClassName: APP_CLASS_NAME, jobId: this.jobId },
        );
      }
    }
  }

  private async enrollAsLeader(): Promise<boolean> {
    if (!this.config.registrationToken) {
      this.logger?.error(
        'zone_crypto enrollment skipped: BROKKR_REGISTRATION_TOKEN not set, ' +
          'cannot run enrollment as leader; mint a token in the hub admin UI and redeploy',
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
      return false;
    }

    this.logger?.info(`zone_crypto enrollment started for zone ${this.zoneId}`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });

    const { zonePriv, zonePub } = generateX25519Keypair();

    // network_error means the request never reached the hub (token unconsumed, zonePub reusable) so retry is safe; other reasons are permanent.
    let hubPub: Buffer | null = null;
    for (let attempt = 1; attempt <= ENROLL_NETWORK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        hubPub = await this.enrollViaHttp(this.zoneId, zonePub);
        break;
      } catch (exc) {
        if (!(exc instanceof EnrollmentError)) throw exc;
        if (exc.reason === 'network_error' && attempt < ENROLL_NETWORK_RETRY_ATTEMPTS) {
          this.logger?.warn(
            `zone_crypto enrollment attempt ${attempt}/${ENROLL_NETWORK_RETRY_ATTEMPTS} failed (reason=network_error): ${exc.message}; retrying`,
            { appClassName: APP_CLASS_NAME, jobId: this.jobId },
          );
          await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
          continue;
        }
        this.logger?.error(`zone_crypto enrollment failed (reason=${exc.reason}): ${exc.message}`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
        return false;
      }
    }
    if (hubPub === null) return false;

    const state: ZoneCryptoSnapshot = { zonePriv, zonePub, hubPub, enrolledAt: Date.now() };

    if (!(await this.persistCache(state))) return false;

    this.codec.setActive(state);
    this.logger?.info(`zone_crypto enrollment succeeded for zone ${this.zoneId}`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });
    await this.writeMarkerBestEffort('enrollment');
    return true;
  }

  private async enrollViaHttp(zoneId: string, zonePub: Buffer): Promise<Buffer> {
    const token = Buffer.from(this.config.registrationToken, 'utf8');
    const url = `${this.config.hubUrl.replace(/\/+$/, '')}/api/v1/zones/${zoneId}/enroll`;

    const requestMac = hmacHex(token, zoneId, zonePub);
    const body = {
      registration_token: this.config.registrationToken,
      zone_pub: zonePub.toString('hex'),
      mac: requestMac,
    };

    // Every body-read await must sit inside the try so mid-stream errors become EnrollmentError('network_error').
    let responsePayload: unknown;
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.httpTimeoutSeconds * 1000),
      });

      if (resp.status === 409) {
        throw new EnrollmentError('token_consumed_no_cache', `hub returned 409: ${await resp.text()}`);
      }
      if (resp.status >= 400) {
        throw new EnrollmentError('hub_rejected_token', `hub returned ${resp.status}: ${await resp.text()}`);
      }

      const contentType = resp.headers.get('content-type') ?? '';
      const isJsonContentType = isAiohttpJsonContentType(contentType);
      const rawBody = await resp.text();
      if (!isJsonContentType) {
        throw new EnrollmentError(
          'hub_response_invalid',
          `hub returned unexpected Content-Type: 0, message='Attempt to decode JSON with unexpected mimetype: ${contentType}', url='${url}'`,
        );
      }
      try {
        responsePayload = JSON.parse(rawBody);
      } catch (exc) {
        throw new EnrollmentError('hub_response_invalid', `hub response is not valid JSON: ${getErrorMessage(exc)}`);
      }
    } catch (exc) {
      if (exc instanceof EnrollmentError) throw exc;
      if (exc instanceof Error && (exc.name === 'TimeoutError' || exc.name === 'AbortError')) {
        throw new EnrollmentError('network_error', `http request timed out after ${this.config.httpTimeoutSeconds}s`);
      }
      throw new EnrollmentError('network_error', `http request failed: ${getErrorMessage(exc)}`);
    }

    if (responsePayload === null || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
      throw new EnrollmentError('hub_response_invalid', 'response body is not a JSON object');
    }

    const hubPubHex: unknown = Reflect.get(responsePayload, 'hub_pub');
    const responseMac: unknown = Reflect.get(responsePayload, 'mac');
    if (typeof hubPubHex !== 'string' || typeof responseMac !== 'string') {
      throw new EnrollmentError('hub_response_invalid', 'response missing hub_pub or mac');
    }

    let hubPub: Buffer;
    try {
      hubPub = decodeHex(hubPubHex);
    } catch (exc) {
      throw new EnrollmentError('hub_response_invalid', `hub_pub is not valid hex: ${getErrorMessage(exc)}`);
    }
    if (hubPub.length !== KEY_SIZE) {
      throw new EnrollmentError('hub_response_invalid', `hub_pub must be ${KEY_SIZE} bytes, got ${hubPub.length}`);
    }

    const expectedMac = hmacHex(token, zoneId, zonePub, hubPub);
    const expectedBuf = Buffer.from(expectedMac, 'utf8');
    const actualBuf = Buffer.from(responseMac, 'utf8');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new EnrollmentError('hub_response_mac_invalid', 'hub response MAC did not verify');
    }

    return hubPub;
  }

  private async persistCache(state: ZoneCryptoSnapshot): Promise<boolean> {
    const blob = this.codec.toCacheBlob(state).toString('utf8');
    try {
      const result = await this.cache.secretSet(this.config.cacheKey, blob, undefined, this.jobId);
      if (!result) {
        this.logger?.error('zone_crypto enrollment failed (cache_write_failed): secret_set returned False', {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
        return false;
      }
      return true;
    } catch (exc) {
      this.logger?.error(`zone_crypto enrollment failed (cache_write_failed): ${getErrorMessage(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return false;
    }
  }

  private async pollAsFollower(): Promise<boolean> {
    const deadline = performance.now() + this.config.pollTotalTimeoutSeconds * 1000;
    let backoffS = this.config.pollInitialBackoffSeconds;

    for (;;) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await this.sleep(Math.min(backoffS * 1000, remainingMs));
      backoffS = Math.min(backoffS * 2, this.config.pollMaxBackoffSeconds);

      if (await this.tryLoadCache()) return true;
    }

    this.logger?.warn(
      `zone_crypto follower poll timed out after ${this.config.pollTotalTimeoutSeconds}s; ` +
        `bridge will run without crypto (zone_crypto_missing)`,
      { appClassName: APP_CLASS_NAME, jobId: this.jobId },
    );
    return false;
  }
}
