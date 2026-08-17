import { randomBytes } from 'node:crypto';
import { getErrorMessage } from '../common/error-utils';

import { Injectable } from '@nestjs/common';

import { ContextLogger } from '../logger/logger.service';

import { type AgentAuthConfig, getAgentAuthConfig } from './agent-auth.config';
import { deviceKey, discoveryKey, hashKey, hashToken, serializeTokenPayload } from './agent-token-codec';

export interface AgentTokenCache {
  delete(key: string, jobId?: string): Promise<number>;
  secretSet(key: string, value: string, ttl?: number | null, jobId?: string): Promise<unknown>;
  secretGet(key: string, jobId?: string): Promise<string | null>;
  acquireLock(
    lockKey: string,
    timeout?: number,
    jobId?: string,
    holderInfo?: Readonly<Record<string, string>>,
  ): Promise<string | null>;
  releaseLock(lockKey: string, token: string, jobId?: string): Promise<boolean>;
}

export interface DeviceSubject {
  kind: 'device';
  deviceId: string;
  issuedAt: number;
}

export interface DiscoverySubject {
  kind: 'discovery';
  discoveryId: string;
  issuedAt: number;
  expiresAt: number;
}

export type AuthSubject = DeviceSubject | DiscoverySubject;

export class AgentTokenMintContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTokenMintContentionError';
  }
}

export interface AgentTokenServiceOptions {
  tokenBytes?: number;
  discoveryTtlS?: number;
  deviceTtlS?: number;
  mintLockTimeoutS?: number;
  mintPollIntervalS?: number;
  mintPollIterations?: number;
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function asRecord(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('agent-token payload is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

@Injectable()
export class AgentTokenService {
  private readonly cache: AgentTokenCache;
  private readonly tokenBytes: number;
  private readonly discoveryTtlS: number;
  private readonly _deviceTtlS: number;
  private readonly mintLockTimeoutS: number;
  private readonly mintPollIntervalS: number;
  private readonly mintPollIterations: number;

  constructor(
    cache: AgentTokenCache,
    private readonly logger: ContextLogger,
    options?: AgentTokenServiceOptions,
    config?: AgentAuthConfig,
  ) {
    const cfg = config ?? getAgentAuthConfig();
    this.cache = cache;
    this.tokenBytes = options?.tokenBytes || cfg.tokenBytes;
    this.discoveryTtlS = options?.discoveryTtlS || cfg.discoveryTtlS;
    this._deviceTtlS = options?.deviceTtlS || cfg.deviceTtlS;
    this.mintLockTimeoutS = options?.mintLockTimeoutS ?? 10.0;
    this.mintPollIntervalS = options?.mintPollIntervalS ?? 0.1;
    this.mintPollIterations = options?.mintPollIterations ?? 20;
  }

  get deviceTtlS(): number {
    return this._deviceTtlS;
  }

  async mintDevice(deviceId: string, jobId = ''): Promise<string> {
    const token = randomBytes(this.tokenBytes).toString('hex');
    const tokenHash = hashToken(token);
    const issuedAt = nowS();
    const hashPayload = serializeTokenPayload({
      kind: 'device',
      device_id: deviceId,
      issued_at: issuedAt,
    });
    const devicePayload = serializeTokenPayload({
      token,
      hash: tokenHash,
      issued_at: issuedAt,
    });
    await this.cache.secretSet(hashKey(tokenHash), hashPayload, this._deviceTtlS, jobId);
    try {
      await this.cache.secretSet(deviceKey(deviceId), devicePayload, this._deviceTtlS, jobId);
    } catch (error) {
      try {
        await this.cache.delete(hashKey(tokenHash), jobId);
      } catch (cleanupError) {
        void this.logger.warning(
          `agent-token mint compensation failed device_id=${deviceId} ` +
            `hash=${tokenHash.slice(0, 12)}... (orphan will expire at ${this._deviceTtlS}s TTL): ${getErrorMessage(cleanupError)}`,
          { jobId },
        );
      }
      throw error;
    }
    void this.logger.info(
      `agent-token minted device device_id=${deviceId} hash=${tokenHash.slice(0, 12)}... ttl=${this._deviceTtlS}s`,
      { jobId },
    );
    return token;
  }

  async verify(token: string, jobId = ''): Promise<AuthSubject | null> {
    if (!token) return null;
    const tokenHash = hashToken(token);
    let raw: string | null;
    try {
      raw = await this.cache.secretGet(hashKey(tokenHash), jobId);
    } catch {
      return null;
    }
    if (raw === null) return null;
    const payload = asRecord(raw);
    if (payload === null) return null;
    const kind = payload['kind'];
    const issuedAt = payload['issued_at'];
    if (!isInt(issuedAt)) return null;
    if (kind === 'device') {
      const deviceId = payload['device_id'];
      if (typeof deviceId !== 'string' || deviceId === '') return null;
      return { kind: 'device', deviceId, issuedAt };
    }
    if (kind === 'discovery') {
      const discoveryId = payload['discovery_id'];
      const expiresAt = payload['expires_at'];
      if (typeof discoveryId !== 'string' || discoveryId === '') return null;
      if (!isInt(expiresAt) || expiresAt <= nowS()) return null;
      return { kind: 'discovery', discoveryId, issuedAt, expiresAt };
    }
    return null;
  }

  async mintOrReuseDevice(deviceId: string, jobId = ''): Promise<string> {
    const reused = await this.tryReuseDevice(deviceId, jobId);
    if (reused !== null) return reused;

    const lockKey = `agent-token:mint:${deviceId}`;
    const lockTimeout = this.mintLockTimeoutS;

    let lockToken = await this.cache.acquireLock(lockKey, Math.trunc(lockTimeout), jobId);

    if (lockToken === null) {
      for (let i = 0; i < this.mintPollIterations; i += 1) {
        await sleep(this.mintPollIntervalS);
        const polled = await this.tryReuseDevice(deviceId, jobId);
        if (polled !== null) return polled;
      }

      void this.logger.warning(
        `agent-token mint lock contended on device_id=${deviceId} lock_key=${lockKey}; waiting ${lockTimeout}s for lock TTL and retrying`,
        { jobId },
      );
      await sleep(lockTimeout);

      const postWait = await this.tryReuseDevice(deviceId, jobId);
      if (postWait !== null) return postWait;

      lockToken = await this.cache.acquireLock(lockKey, Math.trunc(lockTimeout), jobId);
      if (lockToken === null) {
        throw new AgentTokenMintContentionError(
          `agent-token mint: lock on device_id=${deviceId} still contended after ${lockTimeout}s wait; refusing to mint without lock`,
        );
      }
    }

    try {
      const reusedUnderLock = await this.tryReuseDevice(deviceId, jobId);
      if (reusedUnderLock !== null) return reusedUnderLock;
      return await this.mintDevice(deviceId, jobId);
    } finally {
      await this.cache.releaseLock(lockKey, lockToken, jobId);
    }
  }

  async slideDeviceTtl(deviceId: string, jobId = ''): Promise<boolean> {
    return (await this.tryReuseDevice(deviceId, jobId)) !== null;
  }

  async mintDiscovery(discoveryId: string, jobId = ''): Promise<string> {
    const token = randomBytes(this.tokenBytes).toString('hex');
    const tokenHash = hashToken(token);
    const issuedAt = nowS();
    const expiresAt = issuedAt + this.discoveryTtlS;
    const hashPayload = serializeTokenPayload({
      kind: 'discovery',
      discovery_id: discoveryId,
      issued_at: issuedAt,
      expires_at: expiresAt,
    });
    const reusePayload = serializeTokenPayload({
      token,
      hash: tokenHash,
      issued_at: issuedAt,
      expires_at: expiresAt,
    });
    await this.cache.secretSet(hashKey(tokenHash), hashPayload, this.discoveryTtlS, jobId);
    try {
      await this.cache.secretSet(discoveryKey(discoveryId), reusePayload, this.discoveryTtlS, jobId);
    } catch (error) {
      try {
        await this.cache.delete(hashKey(tokenHash), jobId);
      } catch (cleanupError) {
        void this.logger.warning(
          `agent-token mint compensation failed discovery_id=${discoveryId} ` +
            `hash=${tokenHash.slice(0, 12)}... (orphan will expire at ${this.discoveryTtlS}s TTL): ${getErrorMessage(cleanupError)}`,
          { jobId },
        );
      }
      throw error;
    }
    void this.logger.info(
      `agent-token minted discovery discovery_id=${discoveryId} hash=${tokenHash.slice(0, 12)}... ttl=${this.discoveryTtlS}s`,
      { jobId },
    );
    return token;
  }

  async mintOrReuseDiscovery(discoveryId: string, jobId = ''): Promise<string> {
    const reused = await this.tryReuseDiscovery(discoveryId, jobId);
    if (reused !== null) return reused;

    const lockKey = `agent-token:mint:discovery:${discoveryId}`;
    const lockTimeout = this.mintLockTimeoutS;

    let lockToken = await this.cache.acquireLock(lockKey, Math.trunc(lockTimeout), jobId);

    if (lockToken === null) {
      for (let i = 0; i < this.mintPollIterations; i += 1) {
        await sleep(this.mintPollIntervalS);
        const polled = await this.tryReuseDiscovery(discoveryId, jobId);
        if (polled !== null) return polled;
      }

      void this.logger.warning(
        `agent-token mint lock contended on discovery_id=${discoveryId} lock_key=${lockKey}; waiting ${lockTimeout}s for lock TTL and retrying`,
        { jobId },
      );
      await sleep(lockTimeout);

      const postWait = await this.tryReuseDiscovery(discoveryId, jobId);
      if (postWait !== null) return postWait;

      lockToken = await this.cache.acquireLock(lockKey, Math.trunc(lockTimeout), jobId);
      if (lockToken === null) {
        throw new AgentTokenMintContentionError(
          `agent-token mint: lock on discovery_id=${discoveryId} still contended after ${lockTimeout}s wait; refusing to mint without lock`,
        );
      }
    }

    try {
      const reusedUnderLock = await this.tryReuseDiscovery(discoveryId, jobId);
      if (reusedUnderLock !== null) return reusedUnderLock;
      return await this.mintDiscovery(discoveryId, jobId);
    } finally {
      await this.cache.releaseLock(lockKey, lockToken, jobId);
    }
  }

  private async tryReuseDiscovery(discoveryId: string, jobId: string): Promise<string | null> {
    const raw = await this.cache.secretGet(discoveryKey(discoveryId), jobId);
    if (raw === null) return null;
    const payload = asRecord(raw);
    if (payload === null) return null;
    const token = payload['token'];
    const tokenHash = payload['hash'];
    if (typeof token !== 'string' || token === '') return null;
    if (typeof tokenHash !== 'string' || tokenHash === '') return null;
    const now = nowS();
    const newExpiresAt = now + this.discoveryTtlS;
    const carriedIssuedAt = 'issued_at' in payload ? payload['issued_at'] : now;
    const newReuse = serializeTokenPayload({
      token,
      hash: tokenHash,
      issued_at: carriedIssuedAt,
      expires_at: newExpiresAt,
    });
    await this.cache.secretSet(discoveryKey(discoveryId), newReuse, this.discoveryTtlS, jobId);
    const hashPayload = serializeTokenPayload({
      kind: 'discovery',
      discovery_id: discoveryId,
      issued_at: carriedIssuedAt,
      expires_at: newExpiresAt,
    });
    await this.cache.secretSet(hashKey(tokenHash), hashPayload, this.discoveryTtlS, jobId);
    return token;
  }

  private async tryReuseDevice(deviceId: string, jobId: string): Promise<string | null> {
    const raw = await this.cache.secretGet(deviceKey(deviceId), jobId);
    if (raw === null) return null;
    const payload = asRecord(raw);
    if (payload === null) return null;
    const token = payload['token'];
    const tokenHash = payload['hash'];
    if (typeof token !== 'string' || token === '') return null;
    if (typeof tokenHash !== 'string' || tokenHash === '') return null;
    await this.cache.secretSet(deviceKey(deviceId), raw, this._deviceTtlS, jobId);
    const carriedIssuedAt = 'issued_at' in payload ? payload['issued_at'] : nowS();
    const hashPayload = serializeTokenPayload({
      kind: 'device',
      device_id: deviceId,
      issued_at: carriedIssuedAt,
    });
    await this.cache.secretSet(hashKey(tokenHash), hashPayload, this._deviceTtlS, jobId);
    return token;
  }
}
